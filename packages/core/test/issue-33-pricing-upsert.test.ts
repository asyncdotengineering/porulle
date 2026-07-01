import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

// Issue #33 — setBasePrice was insert-only, so editing a price appended a
// duplicate row. It now upserts on the natural key, and ?include=pricing
// exposes each row's id so a consumer can disambiguate.
describe("Issue #33 — pricing setBasePrice upsert", () => {
  let server: any;
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const create = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `price-${Date.now()}`, metadata: { title: "P" } },
      actor: testActor,
    });
    entityId = (await parseJsonResponse<{ data: { id: string } }>(create)).data.id;
  });

  async function setPrice(body: Record<string, unknown>) {
    return makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/pricing/prices",
      body: { entityId, currency: "USD", ...body },
      actor: testActor,
    });
  }

  async function hydratedPricing() {
    const res = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entityId}?include=pricing`,
      actor: testActor,
    });
    const json = await parseJsonResponse<{
      data: { pricing: Array<{ id: string; currency: string; amount: number }> };
    }>(res);
    return json.data.pricing;
  }

  it("replaces the same-key base price instead of appending a duplicate", async () => {
    await setPrice({ amount: 1250 });
    await setPrice({ amount: 1575 });

    const pricing = await hydratedPricing();
    expect(pricing).toHaveLength(1);
    const first = pricing[0]!;
    expect(first.amount).toBe(1575);
    expect(typeof first.id).toBe("string");
    expect(first.id.length).toBeGreaterThan(0);
  });

  it("keeps distinct natural keys as separate rows", async () => {
    await setPrice({ amount: 1250 }); // base
    await setPrice({ amount: 999, minQuantity: 10, maxQuantity: 49 }); // quantity tier

    const pricing = await hydratedPricing();
    expect(pricing).toHaveLength(2);
    const amounts = pricing.map((p) => p.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([999, 1250]);
  });
});
