import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestServer, makeRequest, parseJsonResponse, testActor } from "../src/test-utils/rest-api-test-utils.js";
import type { PriceResolutionContext } from "../src/modules/pricing/service.js";

/**
 * `PriceResolutionContext` declared `customerId?: string` and the resolver never read it: the only
 * customer-dimension matching is `toGroupSet`, which reads `customerGroupIds` and nothing else.
 * A caller passing the obvious field got LIST price while believing it had asked for that
 * customer's price — the same class as pricing a line at a literal, a money path answering
 * confidently without the input it was handed.
 *
 * The contract was decided by what the tree can actually do rather than by preference. There is no
 * way to put a customer INTO a group: `addToGroup`, `removeFromGroup` and `findGroupsByCustomerId`
 * exist on the customers repository and are called by nothing — no service method, no route.
 * Resolving groups from `customerId` would therefore have read an empty set on every call, adding a
 * database round trip to a money hot path to answer a question whose answer is a guaranteed miss.
 * So the field goes, and `customerGroupIds` — the path with real callers that actually works — stays.
 *
 * The row below is a COMPILE-time assertion on purpose. A runtime test cannot observe the absence of
 * an optional property, and the defect was invisible precisely because nothing compared the declared
 * shape to the used one.
 */
type CustomerIdIsNotAcceptedHere = "customerId" extends keyof PriceResolutionContext ? never : true;
const _pinned: CustomerIdIsNotAcceptedHere = true;
void _pinned;

/**
 * The control. Without it the assertion above is satisfied by deleting customer-dimension pricing
 * altogether, which would be a far worse outcome than the defect. These rows prove the dimension
 * that works still works, and must be green both before and after.
 */
type TestServer = Awaited<ReturnType<typeof createTestServer>>;

describe("customer-group pricing, the dimension that is actually wired", () => {
  let server: TestServer["server"];
  let kernel: TestServer["kernel"];
  let cleanup: TestServer["cleanup"];
  let entityId: string;
  const VIP = `vip-${Date.now()}`;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;

    const created = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `pricing-ctx-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        status: "active",
        metadata: { title: "Sari" },
      },
      actor: testActor,
    });
    expect(created.status).toBe(201);
    entityId = (await parseJsonResponse<{ data: { id: string } }>(created)).data.id;

    const list = await kernel.services.pricing.setBasePrice(
      { entityId, currency: "USD", amount: 4000 },
      testActor,
    );
    expect(list.ok).toBe(true);

    const group = await kernel.services.pricing.setBasePrice(
      { entityId, currency: "USD", amount: 3000, customerGroupId: VIP },
      testActor,
    );
    expect(group.ok).toBe(true);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("resolves the group price when the group is supplied", async () => {
    const resolved = await kernel.services.pricing.resolve(
      { entityId, currency: "USD", quantity: 1, customerGroupIds: [VIP] },
      testActor,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected a resolved price");
    expect(resolved.value.finalAmount).toBe(3000);
  });

  it("resolves list price when no group is supplied", async () => {
    const resolved = await kernel.services.pricing.resolve(
      { entityId, currency: "USD", quantity: 1 },
      testActor,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected a resolved price");
    expect(resolved.value.finalAmount).toBe(4000);
  });
});
