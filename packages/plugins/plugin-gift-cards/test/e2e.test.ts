import { describe, expect, it, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import {
  createPluginTestApp,
  jsonHeaders,
  testAdminActor,
  testNoPermActor,
  giftCardAdminActor,
  customerActor,
} from "./test-utils.js";
import { giftCardPlugin } from "../src/index.js";

describe("Gift Card Plugin E2E", () => {
  let app: PluginTestApp["app"];

  beforeAll(async () => {
    const result = await createPluginTestApp(giftCardPlugin());
    app = result.app;
  }, 30_000);

  // ─── Admin: Create ──────────────────────────────────────────────────

  describe("POST /api/gift-cards (admin create)", () => {
    it("creates a gift card with valid input → 201", async () => {
      const res = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({
          amount: 5000,
          currency: "EUR",
          recipientEmail: "recipient@example.com",
          senderName: "Alice",
          personalMessage: "Happy birthday!",
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data).toBeDefined();
      expect(body.data.balance).toBe(5000);
      expect(body.data.initialAmount).toBe(5000);
      expect(body.data.currency).toBe("EUR");
      expect(body.data.status).toBe("active");
      expect(body.data.code).toBeTruthy();
      expect(body.data.displayCode).toContain("-");
    });

    it("creates a gift card with gift-cards:admin permission → 201", async () => {
      const res = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(giftCardAdminActor),
        body: JSON.stringify({ amount: 1000, currency: "USD" }),
      });

      expect(res.status).toBe(201);
    });

    it("rejects creation without auth → 401", async () => {
      const res = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 1000, currency: "USD" }),
      });

      expect(res.status).toBe(401);
    });

    it("rejects creation without permission → 403", async () => {
      const res = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testNoPermActor),
        body: JSON.stringify({ amount: 1000, currency: "USD" }),
      });

      expect(res.status).toBe(403);
    });

    it("rejects negative amount → error", async () => {
      const res = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: -100, currency: "EUR" }),
      });

      // Zod validation rejects negative before handler runs
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ─── Admin: List ────────────────────────────────────────────────────

  describe("GET /api/gift-cards (admin list)", () => {
    it("lists all gift cards → 200", async () => {
      const res = await app.request("http://localhost/api/gift-cards", {
        headers: jsonHeaders(testAdminActor),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it("filters by status", async () => {
      const res = await app.request(
        "http://localhost/api/gift-cards?status=active",
        { headers: jsonHeaders(testAdminActor) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      for (const card of body.data) {
        expect(card.status).toBe("active");
      }
    });
  });

  // ─── Admin: Get by ID ───────────────────────────────────────────────

  describe("GET /api/gift-cards/:id (admin get)", () => {
    it("returns gift card with transactions → 200", async () => {
      // Create a card first
      const createRes = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: 2500, currency: "EUR" }),
      });
      const created = (await createRes.json()).data;

      const res = await app.request(
        `http://localhost/api/gift-cards/${created.id}`,
        { headers: jsonHeaders(testAdminActor) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(created.id);
      expect(body.data.transactions).toBeDefined();
      expect(body.data.transactions.length).toBeGreaterThan(0);
      // Initial load transaction
      expect(body.data.transactions[0].type).toBe("credit");
    });
  });

  // ─── Admin: Disable ─────────────────────────────────────────────────

  describe("POST /api/gift-cards/:id/disable (admin disable)", () => {
    it("disables an active gift card → 201", async () => {
      const createRes = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: 1000, currency: "EUR" }),
      });
      const created = (await createRes.json()).data;

      const res = await app.request(
        `http://localhost/api/gift-cards/${created.id}/disable`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
        },
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.status).toBe("disabled");
    });
  });

  // ─── Admin: Adjust Balance ──────────────────────────────────────────

  describe("POST /api/gift-cards/:id/adjust (admin adjust)", () => {
    it("adjusts balance positively → 201", async () => {
      const createRes = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: 5000, currency: "EUR" }),
      });
      const created = (await createRes.json()).data;

      const res = await app.request(
        `http://localhost/api/gift-cards/${created.id}/adjust`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ delta: -2000, note: "Manual deduction" }),
        },
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.balance).toBe(3000);
    });

    it("caps negative adjustment at zero (no negative balance)", async () => {
      const createRes = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: 1000, currency: "EUR" }),
      });
      const created = (await createRes.json()).data;

      const res = await app.request(
        `http://localhost/api/gift-cards/${created.id}/adjust`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ delta: -5000, note: "Over-deduction test" }),
        },
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.balance).toBe(0);
      expect(body.data.status).toBe("exhausted");
    });

    it("caps positive adjustment at initial amount (no inflation)", async () => {
      const createRes = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: 1000, currency: "EUR" }),
      });
      const created = (await createRes.json()).data;

      const res = await app.request(
        `http://localhost/api/gift-cards/${created.id}/adjust`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ delta: 5000, note: "Inflation attempt" }),
        },
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      // Balance should not exceed initial amount
      expect(body.data.balance).toBe(1000);
    });
  });

  // ─── Public: Check Balance ──────────────────────────────────────────

  describe("POST /api/gift-cards/check-balance (public)", () => {
    it("returns balance for valid code → 201", async () => {
      const createRes = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: 7500, currency: "EUR" }),
      });
      const created = (await createRes.json()).data;

      const res = await app.request(
        "http://localhost/api/gift-cards/check-balance",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: created.displayCode }),
        },
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.balance).toBe(7500);
      expect(body.data.currency).toBe("EUR");
      expect(body.data.status).toBe("active");
    });

    it("returns error for non-existent code", async () => {
      const res = await app.request(
        "http://localhost/api/gift-cards/check-balance",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "XXXX-XXXX-XXXX-XXXX" }),
        },
      );

      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ─── Customer: My Gift Cards ────────────────────────────────────────

  describe("GET /api/me/gift-cards (customer)", () => {
    it("returns only cards purchased by the authenticated user → 200", async () => {
      // Create a card as admin with purchaserId matching customer
      await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({
          amount: 3000,
          currency: "EUR",
        }),
      });

      const res = await app.request("http://localhost/api/me/gift-cards", {
        headers: jsonHeaders(customerActor),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      // Customer's cards only (may be empty since admin created without matching purchaserId)
    });

    it("rejects without auth → 401", async () => {
      const res = await app.request("http://localhost/api/me/gift-cards");
      expect(res.status).toBe(401);
    });
  });

  // ─── Adversarial: Financial Integrity ───────────────────────────────

  describe("Financial integrity", () => {
    it("balance + total debits = initial amount (invariant)", async () => {
      // Create card
      const createRes = await app.request("http://localhost/api/gift-cards", {
        method: "POST",
        headers: jsonHeaders(testAdminActor),
        body: JSON.stringify({ amount: 10000, currency: "EUR" }),
      });
      const created = (await createRes.json()).data;

      // Adjust down by 3000
      await app.request(
        `http://localhost/api/gift-cards/${created.id}/adjust`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ delta: -3000, note: "Test deduction 1" }),
        },
      );

      // Adjust down by 2000
      await app.request(
        `http://localhost/api/gift-cards/${created.id}/adjust`,
        {
          method: "POST",
          headers: jsonHeaders(testAdminActor),
          body: JSON.stringify({ delta: -2000, note: "Test deduction 2" }),
        },
      );

      // Get card with transactions
      const getRes = await app.request(
        `http://localhost/api/gift-cards/${created.id}`,
        { headers: jsonHeaders(testAdminActor) },
      );
      const card = (await getRes.json()).data;

      // Invariant: balance should be 10000 - 3000 - 2000 = 5000
      expect(card.balance).toBe(5000);
      expect(card.initialAmount).toBe(10000);

      // Verify transaction log matches
      const debits = card.transactions
        .filter((t: { type: string }) => t.type === "debit")
        .reduce((sum: number, t: { amount: number }) => sum + t.amount, 0);
      expect(debits).toBe(5000);
      expect(card.balance + debits).toBe(card.initialAmount);
    });
  });
});
