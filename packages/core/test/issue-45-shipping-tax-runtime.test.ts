import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #45 — tax & shipping were code-config only. Runtime REST +
// persistence now exist for shipping zones/rates and tax rates, and both are
// applied during calculation (zones/rates take precedence over code config;
// the adapter/config path remains the fallback).
describe("Issue #45 — runtime shipping zones/rates + tax rates", () => {
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

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `st-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "S" } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  it("CRUDs shipping zones and rates over REST", async () => {
    const zoneRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/shipping/zones",
      body: { name: "United States", countries: ["us"], states: ["NY"] },
      actor: testActor,
    });
    expect(zoneRes.status).toBe(201);
    const zone = (await parseJsonResponse<{ data: any }>(zoneRes)).data;
    expect(zone.countries).toEqual(["US"]); // normalized uppercase

    const rateRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/shipping/rates",
      body: { zoneId: zone.id, name: "Standard", amount: 1500, freeShippingThreshold: 10000 },
      actor: testActor,
    });
    expect(rateRes.status).toBe(201);
    const rate = (await parseJsonResponse<{ data: any }>(rateRes)).data;

    const listZones = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/shipping/zones", actor: testActor }),
    );
    expect(listZones.data.map((z: any) => z.id)).toContain(zone.id);

    const listRates = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: `http://localhost/api/shipping/rates?zoneId=${zone.id}`, actor: testActor }),
    );
    expect(listRates.data.map((r: any) => r.id)).toContain(rate.id);

    const patchRes = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/shipping/rates/${rate.id}`,
      body: { amount: 1800 },
      actor: testActor,
    });
    expect(patchRes.status).toBe(200);
    expect((await parseJsonResponse<{ data: any }>(patchRes)).data.amount).toBe(1800);

    const delRes = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/shipping/rates/${rate.id}`,
      actor: testActor,
    });
    expect(delRes.status).toBe(200);
  });

  it("CRUDs tax rates over REST", async () => {
    const createRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/tax/rates",
      body: { name: "NY sales tax", country: "us", state: "ny", rateBps: 500 },
      actor: testActor,
    });
    expect(createRes.status).toBe(201);
    const rate = (await parseJsonResponse<{ data: any }>(createRes)).data;
    expect(rate.country).toBe("US");
    expect(rate.state).toBe("NY");

    const list = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/tax/rates", actor: testActor }),
    );
    expect(list.data.map((r: any) => r.id)).toContain(rate.id);

    const patch = await makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/tax/rates/${rate.id}`,
      body: { rateBps: 875 },
      actor: testActor,
    });
    expect(patch.status).toBe(200);
    expect((await parseJsonResponse<{ data: any }>(patch)).data.rateBps).toBe(875);

    const del = await makeRequest(server, {
      method: "DELETE",
      url: `http://localhost/api/tax/rates/${rate.id}`,
      actor: testActor,
    });
    expect(del.status).toBe(200);

    // cleanup left no rates behind for later tests
    const after = await parseJsonResponse<{ data: any[] }>(
      await makeRequest(server, { method: "GET", url: "http://localhost/api/tax/rates", actor: testActor }),
    );
    expect(after.data.map((r: any) => r.id)).not.toContain(rate.id);
  });

  it("applies zone rates at shipping calculation, with free-shipping threshold and config fallback", async () => {
    const entityId = await createEntity();

    const zone = (await parseJsonResponse<{ data: any }>(
      await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/shipping/zones",
        body: { name: "US-NE", countries: ["US"], states: ["NY"] },
        actor: testActor,
      }),
    )).data;
    await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/shipping/rates",
      body: { zoneId: zone.id, name: "Standard", amount: 1500, freeShippingThreshold: 10000 },
      actor: testActor,
    });

    const lineItems = [{ entityId, quantity: 1, resolvedTotal: 5000 }];

    // NY address below threshold → zone rate applies
    const nyResult = await kernel.services.shipping.calculate({
      lineItems,
      subtotalAfterDiscount: 5000,
      currency: "USD",
      address: { country: "US", state: "NY", postalCode: "10001" },
      orgId: "org_default",
    });
    expect(nyResult.ok).toBe(true);
    expect(nyResult.value.amount).toBe(1500);
    expect(nyResult.value.strategy).toBe("zone:US-NE:Standard");

    // Above the free-shipping threshold → 0
    const freeResult = await kernel.services.shipping.calculate({
      lineItems: [{ entityId, quantity: 3, resolvedTotal: 15000 }],
      subtotalAfterDiscount: 15000,
      currency: "USD",
      address: { country: "US", state: "NY", postalCode: "10001" },
      orgId: "org_default",
    });
    expect(freeResult.ok).toBe(true);
    expect(freeResult.value.amount).toBe(0);
    expect(freeResult.value.strategy).toBe("zone:US-NE:free_shipping");

    // Address outside every zone → falls back to code config (flat 0 default)
    const caResult = await kernel.services.shipping.calculate({
      lineItems,
      subtotalAfterDiscount: 5000,
      currency: "USD",
      address: { country: "CA", postalCode: "M5V 2T6" },
      orgId: "org_default",
    });
    expect(caResult.ok).toBe(true);
    expect(caResult.value.strategy).toBe("flat");
  });

  it("applies runtime tax rates at calculation, state beating country, adapter as fallback", async () => {
    await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/tax/rates",
      body: { name: "US federal-ish", country: "US", rateBps: 200 },
      actor: testActor,
    });
    await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/tax/rates",
      body: { name: "NY sales tax", country: "US", state: "NY", rateBps: 500, appliesToShipping: false },
      actor: testActor,
    });

    const params = {
      currency: "USD",
      shippingAmount: 1000,
      lineItems: [
        { id: "li-1", entityId: "e-1", description: "Tea", quantity: 2, unitPrice: 5000 },
      ],
    };

    // NY → state-specific rate wins: 5% of 10000 (shipping excluded) = 500
    const ny = await kernel.services.tax.calculate(
      { ...params, toAddress: { country: "US", state: "NY", postalCode: "10001" } },
      "org_default",
    );
    expect(ny.ok).toBe(true);
    expect(ny.value.amountToCollect).toBe(500);

    // Texas → country-level rate: 2% of (10000 + 1000 shipping) = 220
    const tx = await kernel.services.tax.calculate(
      { ...params, toAddress: { country: "US", state: "TX", postalCode: "73301" } },
      "org_default",
    );
    expect(tx.ok).toBe(true);
    expect(tx.value.amountToCollect).toBe(220);

    // Unmatched country → fallback (no adapter configured → zero tax)
    const lk = await kernel.services.tax.calculate(
      { ...params, toAddress: { country: "LK", postalCode: "00100" } },
      "org_default",
    );
    expect(lk.ok).toBe(true);
    expect(lk.value.amountToCollect).toBe(0);
  });
});
