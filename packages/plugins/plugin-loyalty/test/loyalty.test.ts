import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { customers } from "@porulle/core/schema";
import { createPluginTestApp, jsonHeaders, testNoPermActor, loyaltyAdminActor, TEST_ORG_ID } from "./test-utils.js";
import { loyaltyPlugin } from "../src/index.js";
import { LoyaltyService } from "../src/services/loyalty-service.js";

const CUST_A = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const CUST_B = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e";

describe("Loyalty Plugin", () => {
  let app: PluginTestApp["app"];
  let db: PluginTestApp["db"];
  let service: LoyaltyService;

  beforeAll(async () => {
    const result = await createPluginTestApp(loyaltyPlugin({ pointsPerDollar: 1, tierThresholds: { silver: 500, gold: 1500, platinum: 3000 } }));
    app = result.app;
    db = result.db;
    service = new LoyaltyService(db, { silver: 500, gold: 1500, platinum: 3000 });

    // Drizzle-typed insert — column rename in the customers schema would
    // surface as a TS error here, not as a runtime SQL error during tests.
    await result.db.insert(customers).values([
      { id: CUST_A, organizationId: "org_default", userId: "user-a", email: "a@test.local" },
      { id: CUST_B, organizationId: "org_default", userId: "user-b", email: "b@test.local" },
    ]).onConflictDoNothing();
  }, 30_000);

  it("earns points -> correct balance and tier", async () => {
    const result = await service.earnPoints(TEST_ORG_ID, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", 600);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.points).toBe(600);
      expect(result.value.tier).toBe("silver");
    }
  });

  it("earns more points -> tier upgrades", async () => {
    const result = await service.earnPoints(TEST_ORG_ID, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.points).toBe(1600);
      expect(result.value.tier).toBe("gold");
    }
  });

  it("redeems points -> balance decreases", async () => {
    const result = await service.redeemPoints(TEST_ORG_ID, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", 500);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.points).toBe(1100);
  });

  it("rejects redeem when insufficient points", async () => {
    const result = await service.redeemPoints(TEST_ORG_ID, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", 99999);
    expect(result.ok).toBe(false);
  });

  it("leaderboard returns ranked list", async () => {
    await service.earnPoints(TEST_ORG_ID, "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e", 200);
    const result = await service.getLeaderboard(TEST_ORG_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      expect(result.value[0]!.points).toBeGreaterThanOrEqual(result.value[1]!.points);
    }
  });

  // ─── Offers ────────────────────────────────────────────────────

  it("creates a redemption offer -> 201", async () => {
    const res = await app.request("http://localhost/api/loyalty/offers", {
      method: "POST", headers: jsonHeaders(loyaltyAdminActor),
      body: JSON.stringify({ name: "Free Coffee", pointsRequired: 500, rewardType: "free_item", rewardValue: 0 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe("Free Coffee");
    expect(body.data.pointsRequired).toBe(500);
  });

  it("lists active offers -> 200", async () => {
    const res = await app.request("http://localhost/api/loyalty/offers", { headers: jsonHeaders(loyaltyAdminActor) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("redeems offer -> points deducted + timesRedeemed incremented", async () => {
    const listRes = await app.request("http://localhost/api/loyalty/offers", { headers: jsonHeaders(loyaltyAdminActor) });
    const offerId = (await listRes.json()).data[0].id;

    const res = await app.request(`http://localhost/api/loyalty/offers/${offerId}/redeem`, {
      method: "POST", headers: jsonHeaders(loyaltyAdminActor),
      body: JSON.stringify({ customerId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.remainingPoints).toBe(600); // 1100 - 500
  });

  it("no permission -> 403 on offer creation", async () => {
    const res = await app.request("http://localhost/api/loyalty/offers", {
      method: "POST", headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({ name: "X", pointsRequired: 100, rewardType: "free_item", rewardValue: 0 }),
    });
    expect(res.status).toBe(403);
  });

  it("org isolation: other org sees 0 offers", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff", permissions: ["loyalty:admin"],
    };
    const res = await app.request("http://localhost/api/loyalty/offers", { headers: jsonHeaders(otherOrg) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });
});
