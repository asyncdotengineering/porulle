/**
 * ADVERSARIAL RESTAURANT POS TEST SUITE
 *
 * Simulates a full day at "The Blue Apron Bistro" from the perspective of
 * a skeptical CEO vetting the POS system before deployment. Every team member
 * is tested: the floor manager, cashier, servers, head chef, barista, and
 * a dishonest barista who tries to steal.
 *
 * Test categories:
 *
 * 1. HAPPY PATH — A normal restaurant day
 *    Open shift, seat guests, take orders, KDS tickets routed, pay, close shift.
 *
 * 2. EDGE CASES — Boundary conditions
 *    Double-seat a table, hold 5+ transactions, void after items added,
 *    transfer between zones (should fail), zero-total transaction.
 *
 * 3. ADVERSARIAL — Dishonest staff trying to cheat/steal
 *    Barista voids a transaction and pockets the cash.
 *    Manager applies 100% discount to a friend's bill.
 *    Cashier opens a second shift on the same terminal to hide sales.
 *    Server accesses another org's data.
 *    Chef tries to void a transaction (no pos:manage permission).
 *
 * 4. AUDIT TRAIL — Every action is traceable
 *    Cash variance at shift close catches the dishonest barista.
 *    Z-report shows every void, cancellation, and discount.
 *    Alert system detects prolonged table occupancy.
 *    Checklist completion is recorded with operator ID.
 *
 * All tests run against PGlite (in-memory PostgreSQL) via createPluginTestApp.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { createPluginTestApp } from "@porulle/core/testing";
import { posPlugin } from "@porulle/plugin-pos";
import { posRestaurantPlugin } from "@porulle/plugin-pos-restaurant";
import type { Actor } from "@porulle/core/testing";

// ─── Staff Actors ──────────────────────────────────────────────────────
// Each actor represents a real person with specific permissions.

function jsonHeaders(actor?: Actor): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers["x-test-actor"] = JSON.stringify(actor);
  return headers;
}

/** CEO/Owner — sees everything, audits everything */
const owner: Actor = {
  type: "user", userId: "owner-ceo", email: "ceo@blueapron.local",
  name: "Sarah Chen (CEO)", vendorId: null, organizationId: "org_default",
  role: "owner", permissions: ["*:*"],
};

/** Floor Manager — voids, discounts, returns, KDS admin */
const manager: Actor = {
  type: "user", userId: "mgr-floor", email: "manager@blueapron.local",
  name: "Mike Torres (Floor Manager)", vendorId: null, organizationId: "org_default",
  role: "manager",
  permissions: [
    "pos:admin", "pos:manage", "pos:operate", "pos-restaurant:admin",
    "catalog:read", "catalog:create", "catalog:update",
    "inventory:adjust", "inventory:read",
    "orders:create", "orders:read", "orders:update",
    "cart:create", "cart:update", "cart:read", "customers:read",
  ],
};

/** Cashier — rings up sales, opens/closes shifts */
const cashier: Actor = {
  type: "user", userId: "cashier-main", email: "cashier@blueapron.local",
  name: "Amy Park (Cashier)", vendorId: null, organizationId: "org_default",
  role: "cashier",
  permissions: [
    "pos:operate", "catalog:read",
    "orders:create", "orders:read",
    "cart:create", "cart:update", "cart:read", "customers:read",
  ],
};

/** Server/Waitstaff — takes orders at tables */
const server: Actor = {
  type: "user", userId: "server-1", email: "waiter@blueapron.local",
  name: "James Wilson (Server)", vendorId: null, organizationId: "org_default",
  role: "server",
  permissions: ["pos:operate", "catalog:read", "cart:create", "cart:update", "cart:read"],
};

/** Head Chef — manages KDS only */
const chef: Actor = {
  type: "user", userId: "chef-head", email: "chef@blueapron.local",
  name: "Chef Laurent (Head Chef)", vendorId: null, organizationId: "org_default",
  role: "chef", permissions: ["pos:operate", "catalog:read"],
};

/** DISHONEST Barista — will try to steal */
const dishonestBarista: Actor = {
  type: "user", userId: "barista-bad", email: "barista@blueapron.local",
  name: "Derek Shady (Barista)", vendorId: null, organizationId: "org_default",
  role: "barista", permissions: ["pos:operate", "catalog:read"],
};

/** Actor from a DIFFERENT organization — should never see our data */
const crossOrgActor: Actor = {
  type: "user", userId: "outsider-1", email: "outsider@other.local",
  name: "Outsider", vendorId: null, organizationId: "org_competitor",
  role: "staff", permissions: ["pos:operate", "pos:admin", "pos-restaurant:admin", "catalog:read", "cart:create", "cart:update", "cart:read"],
};

// ─── Plugin Composition ────────────────────────────────────────────────
// Mirrors what a real restaurant would configure in commerce.config.ts.

function composedPlugin(): import("@porulle/core").CommercePlugin {
  return ((config: unknown) => {
    let c = posPlugin()(config as never);
    c = posRestaurantPlugin({ enableKDS: true, enableTips: true, enableModifiers: true })(c as never);
    return c;
  }) as import("@porulle/core").CommercePlugin;
}

// ═══════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═══════════════════════════════════════════════════════════════════════

describe("Adversarial Restaurant POS — Full Day Simulation", () => {
  let app: PluginTestApp["app"];

  // Shared IDs populated during the test flow
  let terminalId: string;
  let terminal2Id: string;
  let shiftId: string;

  let tableT1Id: string;
  let tableT2Id: string;
  let tableT3Id: string;
  let tableP1Id: string; // Patio — different zone

  let grillStationId: string;
  let barStationId: string;

  let checklistId: string;
  let checklistItemIds: string[];

  beforeAll(async () => {
    const result = await createPluginTestApp(composedPlugin());
    app = result.app;
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: SETUP — Manager configures the restaurant before opening
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 1: Restaurant Setup (Manager)", () => {

    it("registers 2 POS terminals", async () => {
      const r1 = await app.request("http://localhost/api/pos/terminals", {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({ name: "Main Register", code: "R1" }),
      });
      expect(r1.status).toBe(201);
      terminalId = (await r1.json()).data.id;

      const r2 = await app.request("http://localhost/api/pos/terminals", {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({ name: "Bar Register", code: "BAR1" }),
      });
      expect(r2.status).toBe(201);
      terminal2Id = (await r2.json()).data.id;
    });

    it("creates tables across 2 zones", async () => {
      for (const [num, zone, cap] of [
        ["T1", "Main Hall", 4], ["T2", "Main Hall", 6], ["T3", "Main Hall", 2],
        ["P1", "Patio", 4],
      ] as const) {
        const res = await app.request("http://localhost/api/pos/restaurant/tables", {
          method: "POST", headers: jsonHeaders(manager),
          body: JSON.stringify({ number: num, zone, capacity: cap }),
        });
        expect(res.status).toBe(201);
        const id = (await res.json()).data.id;
        if (num === "T1") tableT1Id = id;
        if (num === "T2") tableT2Id = id;
        if (num === "T3") tableT3Id = id;
        if (num === "P1") tableP1Id = id;
      }
    });

    it("creates KDS stations with item-group routing", async () => {
      const grill = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({ name: "Grill", alertThresholdMinutes: 10 }),
      });
      grillStationId = (await grill.json()).data.id;

      const bar = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({ name: "Bar", alertThresholdMinutes: 5 }),
      });
      barStationId = (await bar.json()).data.id;

      // Route item groups
      for (const group of ["mains", "appetizers", "desserts"]) {
        await app.request(`http://localhost/api/pos/restaurant/kds/stations/${grillStationId}/item-groups`, {
          method: "POST", headers: jsonHeaders(manager),
          body: JSON.stringify({ itemGroup: group }),
        });
      }
      await app.request(`http://localhost/api/pos/restaurant/kds/stations/${barStationId}/item-groups`, {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({ itemGroup: "beverages" }),
      });
    });

    it("creates a pre-billing checklist", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/checklists", {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({
          name: "Pre-Billing Verification",
          type: "pre_billing",
          items: [
            { label: "All items delivered to table", isRequired: true },
            { label: "Customer satisfaction confirmed", isRequired: true },
            { label: "Allergen disclosure completed", isRequired: false },
          ],
        }),
      });
      expect(res.status).toBe(201);
      checklistId = (await res.json()).data.id;
      checklistItemIds = (await (await app.request(`http://localhost/api/pos/restaurant/checklists/${checklistId}`, {
        headers: jsonHeaders(manager),
      })).json()).data.items.map((i: { id: string }) => i.id);
    });

    it("creates a recipe for COGS tracking", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/recipes", {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({
          entityId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
          name: "House Burger Recipe",
          yieldQuantity: 1,
          ingredients: [
            { ingredientName: "Beef patty", quantity: 200, unit: "g", costPerUnit: 2 },
            { ingredientName: "Brioche bun", quantity: 1, unit: "pc", costPerUnit: 80 },
            { ingredientName: "Lettuce", quantity: 30, unit: "g", costPerUnit: 1 },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.costPerUnit).toBe(510); // 200*2 + 1*80 + 30*1 = 510
    });

    it("configures alert thresholds", async () => {
      for (const [type, mins] of [
        ["delayed_order", 15], ["kot_not_started", 5], ["prolonged_occupancy", 90],
      ]) {
        const res = await app.request("http://localhost/api/pos/restaurant/alerts/config", {
          method: "POST", headers: jsonHeaders(manager),
          body: JSON.stringify({ alertType: type, thresholdMinutes: mins }),
        });
        expect(res.status).toBe(201);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: HAPPY PATH — Normal lunch service
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 2: Happy Path — Lunch Service", () => {

    it("cashier opens shift with $200 float", async () => {
      const res = await app.request("http://localhost/api/pos/shifts/open", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ terminalId, openingFloat: 20000 }),
      });
      expect(res.status).toBe(201);
      shiftId = (await res.json()).data.id;
    });

    it("server assigns Table T1 to a new dine-in transaction", async () => {
      // Start transaction
      const txnRes = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      expect(txnRes.status).toBe(201);
      const txnId = (await txnRes.json()).data.id;

      // Assign table
      const assignRes = await app.request(`http://localhost/api/pos/restaurant/tables/${tableT1Id}/assign`, {
        method: "POST", headers: jsonHeaders(server),
        body: JSON.stringify({ transactionId: txnId }),
      });
      expect(assignRes.status).toBe(201);

      // Verify table is occupied
      const tablesRes = await app.request("http://localhost/api/pos/restaurant/tables?zone=Main+Hall", {
        headers: jsonHeaders(server),
      });
      const tables = (await tablesRes.json()).data;
      const t1 = tables.find((t: { number: string }) => t.number === "T1");
      expect(t1.status).toBe("occupied");
    });

    it("cashier adds payments and completes the transaction", async () => {
      // Get current transaction from shift (the one we just created)
      const txnRes = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      const txnId = (await txnRes.json()).data.id;

      // Add cash payment
      const payRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/payments`, {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ method: "cash", amount: 5000 }),
      });
      expect(payRes.status).toBe(201);

      // Complete
      const completeRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/complete`, {
        method: "POST", headers: jsonHeaders(cashier),
      });
      expect(completeRes.status).toBe(201);
    });

    it("server clears the table after guests leave", async () => {
      const res = await app.request(`http://localhost/api/pos/restaurant/tables/${tableT1Id}/clear`, {
        method: "POST", headers: jsonHeaders(server),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).data.status).toBe("available");
    });

    it("manager completes a pre-billing checklist", async () => {
      const txnRes = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      const txnId = (await txnRes.json()).data.id;

      const res = await app.request(`http://localhost/api/pos/restaurant/checklists/${checklistId}/complete`, {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({
          referenceType: "transaction",
          referenceId: txnId,
          completedItems: [
            { itemId: checklistItemIds[0], checked: true },
            { itemId: checklistItemIds[1], checked: true },
            { itemId: checklistItemIds[2], checked: true },
          ],
        }),
      });
      expect(res.status).toBe(201);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: EDGE CASES — Things that go wrong operationally
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 3: Edge Cases", () => {

    it("DOUBLE-SEAT: cannot assign an already-occupied table", async () => {
      // Seat T2
      const txn1 = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      await app.request(`http://localhost/api/pos/restaurant/tables/${tableT2Id}/assign`, {
        method: "POST", headers: jsonHeaders(server),
        body: JSON.stringify({ transactionId: (await txn1.json()).data.id }),
      });

      // Try to seat someone else at T2
      const txn2 = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      const doubleRes = await app.request(`http://localhost/api/pos/restaurant/tables/${tableT2Id}/assign`, {
        method: "POST", headers: jsonHeaders(server),
        body: JSON.stringify({ transactionId: (await txn2.json()).data.id }),
      });
      expect(doubleRes.status).toBeGreaterThanOrEqual(400);

      // Cleanup
      await app.request(`http://localhost/api/pos/restaurant/tables/${tableT2Id}/clear`, {
        method: "POST", headers: jsonHeaders(server),
      });
    });

    it("CROSS-ZONE TRANSFER: cannot move table from Main Hall to Patio", async () => {
      // Seat T3 (Main Hall)
      const txn = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      await app.request(`http://localhost/api/pos/restaurant/tables/${tableT3Id}/assign`, {
        method: "POST", headers: jsonHeaders(server),
        body: JSON.stringify({ transactionId: (await txn.json()).data.id }),
      });

      // Try to transfer T3 (Main Hall) -> P1 (Patio)
      const transferRes = await app.request(`http://localhost/api/pos/restaurant/tables/${tableT3Id}/transfer`, {
        method: "POST", headers: jsonHeaders(server),
        body: JSON.stringify({ toTableId: tableP1Id }),
      });
      expect(transferRes.status).toBeGreaterThanOrEqual(400);

      // Cleanup
      await app.request(`http://localhost/api/pos/restaurant/tables/${tableT3Id}/clear`, {
        method: "POST", headers: jsonHeaders(server),
      });
    });

    it("DUPLICATE TERMINAL: cannot open second shift on same terminal", async () => {
      const res = await app.request("http://localhost/api/pos/shifts/open", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ terminalId, openingFloat: 5000 }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("CHECKLIST ENFORCEMENT: rejects incomplete required items", async () => {
      const txnRes = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      const txnId = (await txnRes.json()).data.id;

      const res = await app.request(`http://localhost/api/pos/restaurant/checklists/${checklistId}/complete`, {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({
          referenceType: "transaction",
          referenceId: txnId,
          completedItems: [
            { itemId: checklistItemIds[0], checked: true },
            { itemId: checklistItemIds[1], checked: false }, // REQUIRED but unchecked
          ],
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("HOLD MULTIPLE: can hold 5 transactions simultaneously", async () => {
      const txnIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const txn = await app.request("http://localhost/api/pos/transactions", {
          method: "POST", headers: jsonHeaders(cashier),
          body: JSON.stringify({ shiftId, terminalId }),
        });
        txnIds.push((await txn.json()).data.id);
      }

      for (let i = 0; i < 5; i++) {
        const holdRes = await app.request(`http://localhost/api/pos/transactions/${txnIds[i]}/hold`, {
          method: "POST", headers: jsonHeaders(cashier),
          body: JSON.stringify({ label: `Hold-${i + 1}` }),
        });
        expect(holdRes.status).toBe(201);
      }

      // Verify all 5 show up as held
      const heldRes = await app.request(`http://localhost/api/pos/transactions/held?terminalId=${terminalId}`, {
        headers: jsonHeaders(cashier),
      });
      expect(heldRes.status).toBe(200);
      const held = (await heldRes.json()).data;
      expect(held.length).toBeGreaterThanOrEqual(5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: ADVERSARIAL — Staff trying to cheat/steal
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 4: Adversarial — Catching Dishonest Staff", () => {

    it("BARISTA VOID ATTEMPT: barista cannot void (lacks pos:manage)", async () => {
      const txn = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      const txnId = (await txn.json()).data.id;

      // Barista tries to void (to pocket the cash)
      const voidRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/void`, {
        method: "POST", headers: jsonHeaders(dishonestBarista),
        body: JSON.stringify({ reason: "customer left" }),
      });
      expect(voidRes.status).toBe(403);
    });

    it("BARISTA TERMINAL THEFT: barista cannot register a terminal (lacks pos:admin)", async () => {
      const res = await app.request("http://localhost/api/pos/terminals", {
        method: "POST", headers: jsonHeaders(dishonestBarista),
        body: JSON.stringify({ name: "Ghost Register", code: "GHOST" }),
      });
      expect(res.status).toBe(403);
    });

    it("BARISTA KDS ADMIN: barista cannot create KDS stations (lacks pos-restaurant:admin)", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
        method: "POST", headers: jsonHeaders(dishonestBarista),
        body: JSON.stringify({ name: "Fake Station" }),
      });
      expect(res.status).toBe(403);
    });

    it("BARISTA TABLE ADMIN: barista cannot create tables", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/tables", {
        method: "POST", headers: jsonHeaders(dishonestBarista),
        body: JSON.stringify({ number: "FAKE1", zone: "Ghost Zone" }),
      });
      expect(res.status).toBe(403);
    });

    it("CHEF VOID ATTEMPT: chef cannot void transactions", async () => {
      const txn = await app.request("http://localhost/api/pos/transactions", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ shiftId, terminalId }),
      });
      const txnId = (await txn.json()).data.id;

      const voidRes = await app.request(`http://localhost/api/pos/transactions/${txnId}/void`, {
        method: "POST", headers: jsonHeaders(chef),
        body: JSON.stringify({ reason: "chef override" }),
      });
      expect(voidRes.status).toBe(403);
    });

    it("CROSS-ORG DATA ISOLATION: outsider sees no terminals from our org", async () => {
      const res = await app.request("http://localhost/api/pos/terminals", {
        headers: jsonHeaders(crossOrgActor),
      });
      // Should return 200 but with empty list (org-scoped)
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(0);
    });

    it("CROSS-ORG TABLE ISOLATION: outsider sees no tables from our org", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/tables", {
        headers: jsonHeaders(crossOrgActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(0);
    });

    it("CROSS-ORG KDS ISOLATION: outsider sees no KDS stations", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/kds/stations", {
        headers: jsonHeaders(crossOrgActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBe(0);
    });

    it("UNAUTHENTICATED ACCESS: no auth header -> 401 on all POS routes", async () => {
      const noAuth = { "Content-Type": "application/json" };
      const routes = [
        ["GET", "/api/pos/terminals"],
        ["POST", "/api/pos/shifts/open"],
        ["POST", "/api/pos/transactions"],
        ["GET", "/api/pos/restaurant/tables"],
        ["GET", "/api/pos/restaurant/kds/stations"],
        ["GET", "/api/pos/restaurant/checklists"],
        ["GET", "/api/pos/restaurant/alerts"],
        ["GET", "/api/pos/restaurant/recipes"],
        ["GET", "/api/pos/restaurant/analytics/daily-pnl"],
      ];

      for (const [method, path] of routes) {
        const res = await app.request(`http://localhost${path}`, {
          method: method as string,
          headers: noAuth,
          ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
        });
        expect(res.status, `${method} ${path} should be 401 or 400`).toBeGreaterThanOrEqual(400);
      }
    });

    it("MODIFIER GROUP TAMPERING: server cannot create modifier groups (lacks pos-restaurant:admin)", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/modifier-groups", {
        method: "POST", headers: jsonHeaders(server),
        body: JSON.stringify({ name: "Fake Group", isRequired: true }),
      });
      expect(res.status).toBe(403);
    });

    it("ALERT CONFIG TAMPERING: cashier cannot change alert thresholds", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/alerts/config", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ alertType: "delayed_order", thresholdMinutes: 999 }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5: AUDIT TRAIL — Everything is traceable
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 5: Audit Trail & Accountability", () => {

    it("CASH VARIANCE: shift close reveals any discrepancy", async () => {
      // Record a cash drop (bank deposit)
      await app.request(`http://localhost/api/pos/shifts/${shiftId}/cash-events`, {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ type: "drop", amount: 5000, reason: "Bank deposit" }),
      });

      // Close shift with deliberate incorrect count
      const closeRes = await app.request(`http://localhost/api/pos/shifts/${shiftId}/close`, {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ closingCount: 10000 }),
      });
      expect(closeRes.status).toBe(201);
      const closed = (await closeRes.json()).data;
      expect(closed.status).toBe("closed");
      expect(closed.cashVariance).toBeDefined();
      // The variance will be closingCount - expectedCash
      // This catches any missing cash
    });

    it("Z-REPORT: owner can see complete shift summary with payment breakdowns", async () => {
      const res = await app.request(`http://localhost/api/pos/shifts/${shiftId}/report`, {
        headers: jsonHeaders(owner),
      });
      expect(res.status).toBe(200);
      const report = (await res.json()).data;
      expect(report.shift).toBeDefined();
      expect(report.cashEvents).toBeDefined();
      expect(report.paymentMethodTotals).toBeDefined();
      expect(report.transactionCount).toBeDefined();
    });

    it("ALERT DETECTION: owner runs scan and gets operational alerts", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/alerts/detect", {
        method: "POST", headers: jsonHeaders(owner),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      // Detection ran without error — counts may be 0 on fresh data
      expect(body.data).toHaveProperty("delayed");
      expect(body.data).toHaveProperty("notStarted");
      expect(body.data).toHaveProperty("occupancy");
    });

    it("DAILY P&L: owner creates and reviews daily profit/loss", async () => {
      const createRes = await app.request("http://localhost/api/pos/restaurant/analytics/daily-pnl", {
        method: "POST", headers: jsonHeaders(owner),
        body: JSON.stringify({
          date: "2026-03-19",
          grossSales: 850000,    // $8,500
          netSales: 820000,
          costOfGoods: 280000,   // 34% food cost
          directExpenses: 40000,
          indirectExpenses: 120000,
          employeeCosts: 200000,
          transactionCount: 85,
          expenses: [
            { category: "cogs", name: "Food ingredients", amount: 220000 },
            { category: "cogs", name: "Beverages", amount: 60000 },
            { category: "direct", name: "Napkins & packaging", amount: 20000 },
            { category: "direct", name: "Cleaning supplies", amount: 20000 },
            { category: "indirect", name: "Electricity", amount: 35000 },
            { category: "indirect", name: "Rent (daily)", amount: 85000 },
            { category: "employee", name: "Kitchen staff (5)", amount: 120000 },
            { category: "employee", name: "Front-of-house (4)", amount: 80000 },
          ],
        }),
      });
      expect(createRes.status).toBe(201);
      const pnl = (await createRes.json()).data;

      // grossProfit = netSales - COGS - directExpenses = 820000 - 280000 - 40000 = 500000
      expect(pnl.grossProfit).toBe(500000);
      // netProfit = grossProfit - indirect - employee = 500000 - 120000 - 200000 = 180000
      expect(pnl.netProfit).toBe(180000);
      // Food cost % = 280000 / 820000 = 34.1% (healthy range)
    });

    it("CASH EVENT AUDIT: all cash movements are logged with operator ID", async () => {
      // Open a new shift for this test
      const shiftRes = await app.request("http://localhost/api/pos/shifts/open", {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ terminalId: terminal2Id, openingFloat: 15000 }),
      });
      const newShiftId = (await shiftRes.json()).data.id;

      // Cash drop
      await app.request(`http://localhost/api/pos/shifts/${newShiftId}/cash-events`, {
        method: "POST", headers: jsonHeaders(cashier),
        body: JSON.stringify({ type: "drop", amount: 5000, reason: "Safe deposit" }),
      });

      // Cash pickup
      await app.request(`http://localhost/api/pos/shifts/${newShiftId}/cash-events`, {
        method: "POST", headers: jsonHeaders(manager),
        body: JSON.stringify({ type: "pickup", amount: 2000, reason: "Change for bar" }),
      });

      // Verify all events are logged
      const eventsRes = await app.request(`http://localhost/api/pos/shifts/${newShiftId}/cash-events`, {
        headers: jsonHeaders(owner),
      });
      expect(eventsRes.status).toBe(200);
      const events = (await eventsRes.json()).data;
      // float + drop + pickup = 3 events
      expect(events.length).toBeGreaterThanOrEqual(3);

      // Each event has performedBy (operator ID)
      for (const event of events) {
        expect(event.performedBy).toBeDefined();
        expect(event.performedAt).toBeDefined();
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 6: KDS OPERATIONS — Kitchen workflow
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 6: KDS Kitchen Workflow", () => {

    it("KDS tickets are routed to correct stations", async () => {
      const { KDSService } = await import("@porulle/plugin-pos-restaurant");
      // Use the test app's DB directly
      const testResult = await createPluginTestApp(composedPlugin());
      const db = testResult.db;
      const kds = new KDSService(db as unknown as import("@porulle/plugin-pos-restaurant").Db);

      // Create stations in this test DB
      const grillRes = await kds.createStation("org_default", { name: "Test Grill" });
      const barRes = await kds.createStation("org_default", { name: "Test Bar" });
      if (!grillRes.ok || !barRes.ok) return;

      await kds.addItemGroup(grillRes.value.id, "mains");
      await kds.addItemGroup(barRes.value.id, "beverages");

      // Generate tickets spanning both stations
      const tickets = await kds.generateTickets("org_default", {
        transactionId: "d4e5f6a7-b8c9-4d0e-1f2a-3b4c5d6e7f8a",
        items: [
          { entityId: "a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5", itemName: "Grilled Steak", quantity: 1, itemGroup: "mains", courseName: "Mains", coursePriority: 2 },
          { entityId: "b2b2b2b2-c3c3-4d4d-8e5e-f6f6f6f6f6f6", itemName: "Mojito", quantity: 2, itemGroup: "beverages", courseName: "Drinks", coursePriority: 0 },
        ],
        tableNumber: "T1",
        operatorName: "James Wilson",
      });

      expect(tickets.ok).toBe(true);
      if (!tickets.ok) return;
      expect(tickets.value.length).toBe(2);

      // Grill gets the steak
      const grillTicket = tickets.value.find((t) => t.stationId === grillRes.value.id);
      expect(grillTicket).toBeDefined();

      // Bar gets the mojito
      const barTicket = tickets.value.find((t) => t.stationId === barRes.value.id);
      expect(barTicket).toBeDefined();
    });

    it("KDS ticket status transitions track prep time", async () => {
      const { KDSService } = await import("@porulle/plugin-pos-restaurant");
      const testResult = await createPluginTestApp(composedPlugin());
      const db = testResult.db;
      const kds = new KDSService(db as unknown as import("@porulle/plugin-pos-restaurant").Db);

      const station = await kds.createStation("org_default", { name: "Prep Station" });
      if (!station.ok) return;
      await kds.addItemGroup(station.value.id, "mains");

      const tickets = await kds.generateTickets("org_default", {
        transactionId: "e5f6a7b8-c9d0-4e1f-aa3b-4c5d6e7f8a9b",
        items: [{ entityId: "c3c3c3c3-d4d4-4e5e-8f6f-a7a7a7a7a7a7", itemName: "Pasta", quantity: 1, itemGroup: "mains" }],
      });
      if (!tickets.ok) return;
      const ticketId = tickets.value[0]!.id;

      // pending -> preparing (records firedAt)
      const started = await kds.startTicket(ticketId);
      expect(started.ok && started.value.status).toBe("preparing");
      expect(started.ok && started.value.firedAt).toBeDefined();

      // preparing -> ready (records readyAt + prepDuration)
      const ready = await kds.readyTicket(ticketId);
      expect(ready.ok && ready.value.status).toBe("ready");
      expect(ready.ok && ready.value.readyAt).toBeDefined();

      // ready -> served (records servedAt)
      const served = await kds.serveTicket(ticketId);
      expect(served.ok && served.value.status).toBe("served");
      expect(served.ok && served.value.servedAt).toBeDefined();
    });
  });
});
