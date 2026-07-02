import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  noPermActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #49 — no runtime settings surface existed: store-level knobs
// (branding, policy values, currency/timezone) required code + redeploy or a
// hand-rolled table. The settings module provides org-scoped typed groups
// over REST plus a read API plugins can consume at request time.
describe("Issue #49 — org-scoped store settings", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("PATCHes branding + policy groups and reads them back over REST", async () => {
    const brandingRes = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/branding",
      body: {
        storeName: "Ordereka Boutique",
        receiptHeader: "Ordereka — Colombo 03",
        receiptFooter: "No returns after 14 days",
      },
      actor: testActor,
    });
    expect(brandingRes.status).toBe(200);
    const branding = (await parseJsonResponse<{ data: any }>(brandingRes)).data;
    expect(branding.storeName).toBe("Ordereka Boutique");

    const policiesRes = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/policies",
      body: { refundDailyCap: 50000, heldSaleTtlMinutes: 120 },
      actor: testActor,
    });
    expect(policiesRes.status).toBe(200);

    // Partial PATCH merges, does not clobber
    const merge = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/policies",
      body: { refundDailyCap: 75000 },
      actor: testActor,
    });
    const merged = (await parseJsonResponse<{ data: any }>(merge)).data;
    expect(merged.refundDailyCap).toBe(75000);
    expect(merged.heldSaleTtlMinutes).toBe(120);

    // null deletes a key
    const del = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/policies",
      body: { heldSaleTtlMinutes: null },
      actor: testActor,
    });
    const afterDelete = (await parseJsonResponse<{ data: any }>(del)).data;
    expect(afterDelete.heldSaleTtlMinutes).toBeUndefined();

    // GET one group
    const one = await parseJsonResponse<{ data: any }>(
      await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/settings/branding",
        actor: testActor,
      }),
    );
    expect(one.data.receiptHeader).toBe("Ordereka — Colombo 03");

    // GET all groups
    const all = await parseJsonResponse<{ data: any }>(
      await makeRequest(server, {
        method: "GET",
        url: "http://localhost/api/settings",
        actor: testActor,
      }),
    );
    expect(all.data.branding.storeName).toBe("Ordereka Boutique");
    expect(all.data.policies.refundDailyCap).toBe(75000);
  });

  it("validates the general group (currency + IANA timezone)", async () => {
    const bad = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/general",
      body: { timezone: "Not/AZone" },
      actor: testActor,
    });
    expect(bad.status).toBe(422);

    const good = await makeRequest(server, {
      method: "PATCH",
      url: "http://localhost/api/settings/general",
      body: { currency: "LKR", timezone: "Asia/Colombo" },
      actor: testActor,
    });
    expect(good.status).toBe(200);
    const general = (await parseJsonResponse<{ data: any }>(good)).data;
    expect(general.timezone).toBe("Asia/Colombo");
  });

  it("requires settings:manage", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/settings",
      actor: noPermActor,
    });
    expect(res.status).toBe(403);
  });

  it("exposes a runtime read API for plugins/hooks", async () => {
    const branding = await kernel.services.settings.read("org_default", "branding");
    expect(branding.storeName).toBe("Ordereka Boutique");

    const policies = await kernel.services.settings.read("org_default", "policies");
    expect(policies.refundDailyCap).toBe(75000);

    // Unset group reads as an empty object, not an error
    const missing = await kernel.services.settings.read("org_default", "nonexistent");
    expect(missing).toEqual({});
  });
});
