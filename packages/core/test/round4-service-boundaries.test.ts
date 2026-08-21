import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

const STORE_ID = "org_default";

const guestActor: Actor = {
  type: "user",
  userId: null,
  email: null,
  name: "Anonymous",
  vendorId: null,
  organizationId: STORE_ID,
  role: "customer",
  permissions: [
    "catalog:read",
    "cart:create",
    "cart:read",
    "cart:update",
    "orders:create",
    "orders:read:own",
  ],
};

function customerActor(userId: string): Actor {
  return {
    ...guestActor,
    userId,
    email: userId + "@example.com",
    name: userId,
  };
}

const apiKeyOperator: Actor = {
  type: "api_key",
  userId: "pos-operator",
  email: null,
  name: "POS shift",
  vendorId: null,
  organizationId: STORE_ID,
  role: "api_key",
  permissions: ["catalog:read", "orders:create", "orders:read"],
};

describe("round 4 service boundaries", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Awaited<ReturnType<typeof createTestServer>>["kernel"];
  let cleanup: () => Promise<void>;

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
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createProduct(): Promise<string> {
    const product = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `round4-${crypto.randomUUID()}`,
        status: "active",
        attributes: { title: "Round 4 Product" },
      },
      testActor,
    );
    expect(product.ok).toBe(true);
    if (!product.ok) throw product.error;

    const price = await kernel.services.pricing.setBasePrice(
      { entityId: product.value.id, currency: "USD", amount: 2500 },
      testActor,
    );
    expect(price.ok).toBe(true);
    const stock = await kernel.services.inventory.adjust(
      { entityId: product.value.id, adjustment: 10, reason: "round 4 checkout fixture" },
      testActor,
    );
    expect(stock.ok).toBe(true);
    return product.value.id;
  }

  async function createGuestCart(actor: Actor = guestActor): Promise<{ id: string; secret: string }> {
    const response = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/carts",
      body: { currency: "USD" },
      actor,
    });
    expect(response.status).toBe(201);
    const body = await parseJsonResponse<{ data: { id: string; secret: string } }>(response);
    return body.data;
  }

  function orderBody(entityId: string, idempotencyKey: string, cartId?: string) {
    return {
      idempotencyKey,
      currency: "USD",
      subtotal: 2500,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 2500,
      ...(cartId ? { metadata: { cartId, shippingAddress: { line1: "Victim address" } } } : {}),
      lineItems: [{
        entityId,
        entityType: "product",
        title: "Round 4 Product",
        quantity: 1,
        unitPrice: 2500,
        totalPrice: 2500,
      }],
    };
  }

  it("binds direct order replay to the guest credential and customer owner", async () => {
    const entityId = await createProduct();
    const victimCart = await createGuestCart();
    const attackerCart = await createGuestCart();
    const guestKey = `round4-direct-guest-${crypto.randomUUID()}`;

    const victim = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(entityId, guestKey, victimCart.id),
      headers: { "x-cart-secret": victimCart.secret },
      actor: guestActor,
    });
    expect(victim.status).toBe(201);
    const victimOrder = await parseJsonResponse<{ data: { id: string; metadata: Record<string, unknown> } }>(victim);

    const guestReplay = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(entityId, guestKey, attackerCart.id),
      headers: { "x-cart-secret": attackerCart.secret },
      actor: guestActor,
    });
    expect(guestReplay.status).toBe(201);
    const guestReplayBody = await guestReplay.text();
    expect(guestReplayBody).not.toContain(victimOrder.data.id);

    const customerA = customerActor("round4-customer-a");
    const customerB = customerActor("round4-customer-b");
    const customerKey = `round4-direct-customer-${crypto.randomUUID()}`;
    const customerVictim = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(entityId, customerKey),
      actor: customerA,
    });
    expect(customerVictim.status).toBe(201);

    const customerReplay = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: orderBody(entityId, customerKey),
      actor: customerB,
    });
    expect(customerReplay.status).toBe(201);
  });

  it("scopes checkout replay preflight to the requester binding", async () => {
    const entityId = await createProduct();
    const victimCart = await createGuestCart();
    const attackerCart = await createGuestCart();
    const attackerItem = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/carts/${attackerCart.id}/items`,
      body: { entityId, quantity: 1 },
      headers: { "x-cart-secret": attackerCart.secret },
      actor: guestActor,
    });
    expect(attackerItem.status).toBe(201);
    const key = `round4-checkout-${crypto.randomUUID()}`;

    const victim = await kernel.services.orders.create(
      orderBody(entityId, key, victimCart.id),
      guestActor,
      undefined,
      { trustedPricing: true, guestCredential: victimCart.secret },
    );
    expect(victim.ok).toBe(true);

    const replay = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: {
        cartId: attackerCart.id,
        paymentMethodId: "test-payments",
        idempotencyKey: key,
      },
      headers: { "x-cart-secret": attackerCart.secret },
      actor: guestActor,
    });
    expect(replay.status).toBe(201);
  });

  it("allows different requester bindings to use the same key", async () => {
    const entityId = await createProduct();
    const firstCart = await createGuestCart();
    const secondCart = await createGuestCart();
    const key = `round4-race-${crypto.randomUUID()}`;

    const [first, second] = await Promise.all([
      kernel.services.orders.create(
        orderBody(entityId, key, firstCart.id),
        guestActor,
        undefined,
        { trustedPricing: true, guestCredential: firstCart.secret },
      ),
      kernel.services.orders.create(
        orderBody(entityId, key, secondCart.id),
        guestActor,
        undefined,
        { trustedPricing: true, guestCredential: secondCart.secret },
      ),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.id).not.toBe(second.value.id);
  });

  it("lets an api_key operator attribute a POS sale to a walk-in customer", async () => {
    const entityId = await createProduct();
    const walkIn = await kernel.services.customers.createWalkIn(
      { firstName: "Walk-in", metadata: { source: "pos" } },
      { ...testActor, permissions: ["*:*"] },
    );
    expect(walkIn.ok).toBe(true);
    if (!walkIn.ok) throw walkIn.error;

    const response = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        ...orderBody(entityId, `round4-pos-${crypto.randomUUID()}`),
        customerId: walkIn.value.id,
      },
      actor: apiKeyOperator,
    });
    expect(response.status).toBe(201);
    const body = await parseJsonResponse<{ data: { customerId: string | null } }>(response);
    expect(body.data.customerId).toBe(walkIn.value.id);
  });
});
