import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, restaurantAdminActor, serverActor } from "./test-utils.js";
import { posRestaurantPlugin } from "../src/index.js";

describe("POS Restaurant Operations", () => {
  let app: PluginTestApp["app"];

  beforeAll(async () => {
    const result = await createPluginTestApp(posRestaurantPlugin());
    app = result.app;
  }, 30_000);

  // ─── Checklists ──────────────────────────────────────────────────

  describe("Checklists", () => {
    let checklistId: string;
    let itemIds: string[];

    it("creates a pre-billing checklist with items -> 201", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/checklists", {
        method: "POST",
        headers: jsonHeaders(restaurantAdminActor),
        body: JSON.stringify({
          name: "Pre-Billing Check",
          type: "pre_billing",
          items: [
            { label: "Stock verified", isRequired: true },
            { label: "Hygiene check passed", isRequired: true },
            { label: "Customer feedback collected", isRequired: false },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      checklistId = body.data.id;
      itemIds = body.data.items.map((i: { id: string }) => i.id);
      expect(body.data.items.length).toBe(3);
    });

    it("lists checklists by type -> 200", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/checklists?type=pre_billing", {
        headers: jsonHeaders(serverActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("completes a checklist with all required items -> 201", async () => {
      const txnId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
      const res = await app.request(`http://localhost/api/pos/restaurant/checklists/${checklistId}/complete`, {
        method: "POST",
        headers: jsonHeaders(serverActor),
        body: JSON.stringify({
          referenceType: "transaction",
          referenceId: txnId,
          completedItems: [
            { itemId: itemIds[0], checked: true },
            { itemId: itemIds[1], checked: true },
            { itemId: itemIds[2], checked: false },
          ],
        }),
      });
      expect(res.status).toBe(201);
    });

    it("rejects incomplete required checklist items -> error", async () => {
      const txnId = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";
      const res = await app.request(`http://localhost/api/pos/restaurant/checklists/${checklistId}/complete`, {
        method: "POST",
        headers: jsonHeaders(serverActor),
        body: JSON.stringify({
          referenceType: "transaction",
          referenceId: txnId,
          completedItems: [
            { itemId: itemIds[0], checked: true },
            { itemId: itemIds[1], checked: false }, // required but not checked
          ],
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ─── Alerts ──────────────────────────────────────────────────────

  describe("Alerts", () => {
    it("sets alert threshold -> 201", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/alerts/config", {
        method: "POST",
        headers: jsonHeaders(restaurantAdminActor),
        body: JSON.stringify({
          alertType: "delayed_order",
          thresholdMinutes: 15,
          notifyRoles: ["manager"],
        }),
      });
      expect(res.status).toBe(201);
    });

    it("gets alert configuration -> 200", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/alerts/config", {
        headers: jsonHeaders(restaurantAdminActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("runs alert detection -> 201", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/alerts/detect", {
        method: "POST",
        headers: jsonHeaders(restaurantAdminActor),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data).toHaveProperty("delayed");
      expect(body.data).toHaveProperty("notStarted");
      expect(body.data).toHaveProperty("occupancy");
    });

    it("lists alerts -> 200", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/alerts", {
        headers: jsonHeaders(serverActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // ─── Recipes/BOM ─────────────────────────────────────────────────

  describe("Recipes", () => {
    it("creates a recipe with ingredients for COGS -> 201", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/recipes", {
        method: "POST",
        headers: jsonHeaders(restaurantAdminActor),
        body: JSON.stringify({
          entityId: "e5f6a7b8-c9d0-4e1f-aa3b-4c5d6e7f8a9b",
          name: "Grilled Steak Recipe",
          yieldQuantity: 1,
          ingredients: [
            { ingredientName: "Beef steak", quantity: 300, unit: "g", costPerUnit: 3 },
            { ingredientName: "Olive oil", quantity: 20, unit: "ml", costPerUnit: 1 },
            { ingredientName: "Salt", quantity: 5, unit: "g", costPerUnit: 0 },
            { ingredientName: "Pepper", quantity: 3, unit: "g", costPerUnit: 1 },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.costPerUnit).toBe(923); // 300*3 + 20*1 + 5*0 + 3*1 = 923
    });

    it("lists recipes -> 200", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/recipes", {
        headers: jsonHeaders(restaurantAdminActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it("gets recipe with ingredient breakdown -> 200", async () => {
      const listRes = await app.request("http://localhost/api/pos/restaurant/recipes", {
        headers: jsonHeaders(restaurantAdminActor),
      });
      const recipes = (await listRes.json()).data;
      const recipeId = recipes[0].id;

      const res = await app.request(`http://localhost/api/pos/restaurant/recipes/${recipeId}`, {
        headers: jsonHeaders(restaurantAdminActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ingredients.length).toBe(4);
      expect(body.data.totalCost).toBe(923);
    });
  });

  // ─── Daily P&L Analytics ─────────────────────────────────────────

  describe("Analytics", () => {
    it("creates daily P&L with expense breakdown -> 201", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/analytics/daily-pnl", {
        method: "POST",
        headers: jsonHeaders(restaurantAdminActor),
        body: JSON.stringify({
          date: "2026-03-19",
          grossSales: 500000,
          netSales: 480000,
          costOfGoods: 150000,
          directExpenses: 30000,
          indirectExpenses: 50000,
          employeeCosts: 80000,
          transactionCount: 120,
          expenses: [
            { category: "cogs", name: "Food ingredients", amount: 120000 },
            { category: "cogs", name: "Beverages", amount: 30000 },
            { category: "direct", name: "Napkins & consumables", amount: 15000 },
            { category: "direct", name: "Packaging", amount: 15000 },
            { category: "indirect", name: "Electricity", amount: 25000 },
            { category: "indirect", name: "Rent (daily)", amount: 25000 },
            { category: "employee", name: "Kitchen staff", amount: 50000 },
            { category: "employee", name: "Service staff", amount: 30000 },
          ],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      // grossProfit = 480000 - 150000 - 30000 = 300000
      expect(body.data.grossProfit).toBe(300000);
      // netProfit = 300000 - 50000 - 80000 = 170000
      expect(body.data.netProfit).toBe(170000);
      expect(body.data.averageBillValue).toBe(4167); // Math.round(500000/120)
    });

    it("lists daily P&L records -> 200", async () => {
      const res = await app.request("http://localhost/api/pos/restaurant/analytics/daily-pnl", {
        headers: jsonHeaders(restaurantAdminActor),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });
  });
});
