import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestServer, makeRequest, parseJsonResponse } from "../src/test-utils/rest-api-test-utils.js";
import { testActor } from "../src/test-utils/test-actors.js";

/**
 * A storefront records why a piece went into the bag (the search that showed it, whether it is a gift) on the cart line, and the
 * order line carries it on. Written before the code. The ways it could fail:
 *   1. the HTTP body drops `metadata` (the schema had no such field, so zod stripped it) and the line stores {};
 *   2. a caller stores an unbounded or nested blob on every line;
 *   3. checkout builds the order lines without the cart line's metadata, so the purchase loses what the add recorded.
 */
describe("cart line metadata over HTTP", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Awaited<ReturnType<typeof createTestServer>>["kernel"];
  let cleanup: () => Promise<void>;
  let entityId: string;
  const metadata = { requestId: "6f1c2a7e-0000-4000-8000-000000000001", forSomeoneElse: true };

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });
  afterAll(async () => {
    await cleanup();
  });
  beforeEach(async () => {
    await cleanup();
    const created = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `meta-${Date.now()}`, metadata: { title: "Gift Shirt", basePrice: 1000 } },
      actor: testActor,
    });
    entityId = (await parseJsonResponse<{ data: { id: string } }>(created)).data.id;
    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" }, testActor);
    await kernel.services.inventory.adjust({ entityId, adjustment: 10, reason: "metadata test stock" }, testActor);
  });

  async function cartWithLine(body: Record<string, unknown>): Promise<{ cartId: string; response: Response }> {
    const cart = await makeRequest(server, { method: "POST", url: "http://localhost/api/carts", body: { currency: "USD" } });
    const cartId = (await parseJsonResponse<{ data: { id: string } }>(cart)).data.id;
    const response = await makeRequest(server, { method: "POST", url: `http://localhost/api/carts/${cartId}/items`, body: { entityId, quantity: 1, ...body } });
    return { cartId, response };
  }

  it("stores the metadata the add sent on the line", async () => {
    const { response } = await cartWithLine({ metadata });
    expect(response.status).toBe(201);
    const line = await parseJsonResponse<{ data: { metadata: Record<string, unknown> } }>(response);
    expect(line.data.metadata).toEqual(metadata);
  });

  it("refuses nested values, too many keys and long values", async () => {
    const nested = await cartWithLine({ metadata: { deep: { a: 1 } } });
    expect([400, 422]).toContain(nested.response.status);
    const tooMany = await cartWithLine({ metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, index])) });
    expect([400, 422]).toContain(tooMany.response.status);
    const longValue = await cartWithLine({ metadata: { note: "x".repeat(257) } });
    expect([400, 422]).toContain(longValue.response.status);
  });

  it("carries the line's metadata onto the order line at checkout", async () => {
    const { cartId } = await cartWithLine({ metadata });
    const response = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: {
        cartId,
        paymentMethodId: "test-payments",
        currency: "USD",
        shippingAddress: { country: "US", postalCode: "90001", state: "CA", city: "Los Angeles", line1: "123 Test St" },
      },
      actor: testActor,
    });
    expect(response.status).toBe(201);
    const order = await parseJsonResponse<{ data: { lineItems: Array<{ metadata: Record<string, unknown> }> } }>(response);
    expect(order.data.lineItems[0]?.metadata).toEqual(metadata);
  });
});
