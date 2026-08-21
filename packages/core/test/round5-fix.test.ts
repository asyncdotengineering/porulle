import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

const STORE_ID = "org_round5_fix_store";
const OTHER_ORG_ID = "org_round5_fix_other";

const guestActor: Actor = {
  type: "user",
  userId: null,
  email: null,
  name: "Anonymous",
  vendorId: null,
  organizationId: STORE_ID,
  role: "customer",
  permissions: ["catalog:read", "cart:create", "cart:read", "cart:update", "orders:create", "orders:read:own"],
};

const replayReader: Actor = {
  type: "api_key",
  userId: "round5-replay-reader",
  email: null,
  name: "Clienteling reader",
  vendorId: null,
  organizationId: STORE_ID,
  role: "api_key",
  permissions: ["catalog:read", "orders:create", "customers:read"],
};

const operator: Actor = {
  type: "api_key",
  userId: "round5-operator",
  email: null,
  name: "POS operator",
  vendorId: null,
  organizationId: STORE_ID,
  role: "api_key",
  permissions: ["catalog:read", "orders:create", "orders:read"],
};

const admin = (organizationId: string): Actor => ({
  ...testActor,
  organizationId,
  permissions: ["*:*"],
});

describe("round 5 fixes", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Awaited<ReturnType<typeof createTestServer>>["kernel"];
  let cleanup: () => Promise<void>;
  let productId: string;

  beforeAll(async () => {
    const result = await createTestServer({
      auth: {
        storeResolver: (request) => request.headers.get("x-store-id") ?? STORE_ID,
      },
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  beforeEach(async () => {
    await cleanup();
    await kernel.services.organization.create({
      id: STORE_ID,
      name: "Round 5 Store",
      slug: `round5-store-${crypto.randomUUID()}`,
    });
    await kernel.services.organization.create({
      id: OTHER_ORG_ID,
      name: "Round 5 Other",
      slug: `round5-other-${crypto.randomUUID()}`,
    });
    const product = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `round5-fix-${crypto.randomUUID()}`,
        status: "active",
        attributes: { title: "Round 5 Product" },
      },
      admin(STORE_ID),
    );
    expect(product.ok).toBe(true);
    if (!product.ok) throw product.error;
    productId = product.value.id;
    const price = await kernel.services.pricing.setBasePrice(
      { entityId: productId, currency: "USD", amount: 2500 },
      admin(STORE_ID),
    );
    expect(price.ok).toBe(true);
    const warehouse = await kernel.services.inventory.createWarehouse(
      { name: "Round 5 Warehouse", code: `R5-${crypto.randomUUID()}` },
      admin(STORE_ID),
    );
    expect(warehouse.ok).toBe(true);
    const stock = await kernel.services.inventory.adjust(
      { entityId: productId, adjustment: 20, reason: "round 5 fix fixture" },
      admin(STORE_ID),
    );
    expect(stock.ok).toBe(true);
  });

  afterAll(async () => {
    await cleanup();
  });

  function orderBody(idempotencyKey: string, cartId?: string) {
    return {
      idempotencyKey,
      currency: "USD",
      subtotal: 2500,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 2500,
      ...(cartId ? { metadata: { cartId, shippingAddress: { line1: "Round 5 private address" } } } : {}),
      lineItems: [{
        entityId: productId,
        entityType: "product",
        title: "Round 5 Product",
        quantity: 1,
        unitPrice: 2500,
        totalPrice: 2500,
      }],
    };
  }

  async function createGuestCart(): Promise<{ id: string; secret: string }> {
    const response = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/carts",
      body: { currency: "USD" },
      actor: guestActor,
    });
    expect(response.status).toBe(201);
    const cart = (await parseJsonResponse<{ data: { id: string; secret: string } }>(response)).data;
    const item = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/carts/${cart.id}/items`,
      body: { entityId: productId, quantity: 1 },
      headers: { "x-cart-secret": cart.secret },
      actor: guestActor,
    });
    expect(item.status).toBe(201);
    return cart;
  }

  it("does not make replay a read capability without orders:read", async () => {
    const key = `round5-b1-${crypto.randomUUID()}`;
    const first = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(key),
      actor: replayReader,
    });
    expect(first.status).toBe(201);
    const firstOrder = (await parseJsonResponse<{ data: { id: string; orderNumber: string } }>(first)).data;

    const replay = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(key),
      actor: replayReader,
    });
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain("Round 5 private address");

    const directRead = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${firstOrder.id}`,
      actor: replayReader,
    });
    expect(directRead.status).toBe(403);
    const numberRead = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${firstOrder.orderNumber}`,
      actor: replayReader,
    });
    expect(numberRead.status).toBe(403);
  });

  it("rejects an API-key customerId that is foreign or nonexistent", async () => {
    const foreign = await kernel.services.customers.getByUserId(
      "round5-foreign-user",
      admin(OTHER_ORG_ID),
    );
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) throw foreign.error;

    for (const customerId of [foreign.value.id, crypto.randomUUID()]) {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/orders",
        body: { ...orderBody(`round5-b2-${crypto.randomUUID()}`), customerId },
        actor: operator,
      });
      expect(response.status).toBe(422);
    }
  });

  it("scopes a key to its requester, allowing another requester to create or checkout with it", async () => {
    const key = `round5-b3-${crypto.randomUUID()}`;
    const attackerCart = await createGuestCart();
    const attacker = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(key, attackerCart.id),
      headers: { "x-cart-secret": attackerCart.secret },
      actor: guestActor,
    });
    expect(attacker.status).toBe(201);
    const attackerOrder = (await parseJsonResponse<{ data: { id: string } }>(attacker)).data;

    const victimCart = await createGuestCart();
    const victim = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: { cartId: victimCart.id, paymentMethodId: "test-payments", idempotencyKey: key },
      headers: { "x-cart-secret": victimCart.secret },
      actor: guestActor,
    });
    expect(victim.status).toBe(201);
    const victimOrder = (await parseJsonResponse<{ data: { id: string } }>(victim)).data;
    expect(victimOrder.id).not.toBe(attackerOrder.id);
  });
});
