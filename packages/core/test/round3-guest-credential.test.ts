import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";
import type { Actor } from "../src/auth/types.js";

const STORE_ID = "org_default";
const MULTI_STORE_ID = "org_round3_multistore";

const customerActor: Actor = {
  type: "user",
  userId: "round3-customer-user",
  email: "round3-customer@example.com",
  name: "Round 3 Customer",
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

function jsonRequest(
  url: string,
  init: { method?: string; body?: unknown; secret?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-store-id": STORE_ID,
  };
  if (init.secret) headers["x-cart-secret"] = init.secret;
  return new Request(url, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe("round 3 guest credential and checkout regressions", () => {
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

  async function createSellableProduct(actor: Actor = testActor): Promise<string> {
    const product = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `round3-${crypto.randomUUID()}`,
        status: "active",
        attributes: { title: "Round 3 Product" },
      },
      actor,
    );
    expect(product.ok).toBe(true);
    if (!product.ok) throw product.error;

    const price = await kernel.services.pricing.setBasePrice(
      { entityId: product.value.id, currency: "USD", amount: 2500 },
      actor,
    );
    expect(price.ok).toBe(true);

    const warehouse = await kernel.services.inventory.createWarehouse(
      { name: "Round 3 Warehouse", code: `R3-${crypto.randomUUID()}` },
      actor,
    );
    expect(warehouse.ok).toBe(true);
    const stock = await kernel.services.inventory.adjust(
      {
        entityId: product.value.id,
        warehouseId: warehouse.ok ? warehouse.value.id : undefined,
        adjustment: 10,
        reason: "round 3 checkout fixture",
      },
      actor,
    );
    expect(stock.ok).toBe(true);
    return product.value.id;
  }

  async function createGuestCart(): Promise<{ id: string; secret: string }> {
    const response = await server.fetch(jsonRequest("http://localhost/api/carts", {
      method: "POST",
      body: { currency: "USD" },
    }));
    expect(response.status).toBe(201);
    const body = await parseJsonResponse<{ data: { id: string; secret: string } }>(response);
    return { id: body.data.id, secret: body.data.secret };
  }

  it("lets a guest buy end to end and requires the cart credential for the order", async () => {
    const entityId = await createSellableProduct();
    const cart = await createGuestCart();

    const added = await server.fetch(jsonRequest(
      `http://localhost/api/carts/${cart.id}/items`,
      { method: "POST", secret: cart.secret, body: { entityId, quantity: 1 } },
    ));
    expect(added.status).toBe(201);

    const checkoutWithoutCredential = await server.fetch(jsonRequest("http://localhost/api/checkout", {
      method: "POST",
      body: { cartId: cart.id, paymentMethodId: "test-payments" },
    }));
    expect(checkoutWithoutCredential.status).toBe(403);

    const checkout = await server.fetch(jsonRequest("http://localhost/api/checkout", {
      method: "POST",
      secret: cart.secret,
      body: {
        cartId: cart.id,
        paymentMethodId: "test-payments",
        currency: "USD",
        idempotencyKey: `round3-${crypto.randomUUID()}`,
        shippingAddress: {
          line1: "1 Guest Lane",
          city: "Colombo",
          postalCode: "00100",
          country: "LK",
        },
      },
    }));
    expect(checkout.status).toBe(201);
    const order = await parseJsonResponse<{
      data: {
        id: string;
        orderNumber: string;
        customerId: string | null;
        lineItems: Array<{ id: string }>;
      };
    }>(checkout);
    expect(order.data.customerId).toBeNull();

    const noCredential = await server.fetch(jsonRequest(
      `http://localhost/api/orders/${order.data.orderNumber}`,
    ));
    expect(noCredential.status).toBe(403);

    const credentialed = await server.fetch(jsonRequest(
      `http://localhost/api/orders/${order.data.id}`,
      { secret: cart.secret },
    ));
    expect(credentialed.status).toBe(200);

    const byNumber = await server.fetch(jsonRequest(
      `http://localhost/api/orders/${order.data.orderNumber}`,
      { secret: cart.secret },
    ));
    expect(byNumber.status).toBe(200);

    const invoice = await server.fetch(jsonRequest(
      `http://localhost/api/orders/${order.data.id}/invoice.html`,
      { secret: cart.secret },
    ));
    expect(invoice.status).toBe(200);
    expect(await invoice.text()).toContain("Round 3 Product");

    const receipt = await server.fetch(jsonRequest(
      `http://localhost/api/orders/${order.data.id}/receipt.html`,
      { secret: cart.secret },
    ));
    expect(receipt.status).toBe(200);
    expect(await receipt.text()).toContain("Round 3 Product");

  });

  it("does not replay an idempotency key for a different cart credential", async () => {
    const entityId = await createSellableProduct();
    const victimCart = await createGuestCart();
    const attackerCart = await createGuestCart();
    const idempotencyKey = `round3-replay-${crypto.randomUUID()}`;

    const victimOrder = await kernel.services.orders.create(
      {
        idempotencyKey,
        currency: "USD",
        subtotal: 2500,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2500,
        metadata: {
          cartId: victimCart.id,
          shippingAddress: { line1: "Victim address" },
        },
        lineItems: [{
          entityId,
          entityType: "product",
          title: "Round 3 Product",
          quantity: 1,
          unitPrice: 2500,
          totalPrice: 2500,
        }],
      },
      testActor,
    );
    expect(victimOrder.ok).toBe(true);

    const replay = await server.fetch(jsonRequest("http://localhost/api/checkout", {
      method: "POST",
      secret: attackerCart.secret,
      body: {
        cartId: attackerCart.id,
        paymentMethodId: "test-payments",
        idempotencyKey,
      },
    }));

    expect([409, 422]).toContain(replay.status);
  });

  it("does not let an anonymous order create write into another customer's history", async () => {
    const entityId = await createSellableProduct();
    const victim = await kernel.services.customers.getByUserId(
      "round3-victim-user",
      testActor,
    );
    expect(victim.ok).toBe(true);
    if (!victim.ok) throw victim.error;

    const response = await server.fetch(jsonRequest("http://localhost/api/orders", {
      method: "POST",
      body: {
        customerId: victim.value.id,
        currency: "USD",
        subtotal: 2500,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2500,
        lineItems: [{
          entityId,
          entityType: "product",
          title: "Round 3 Product",
          quantity: 1,
          unitPrice: 2500,
          totalPrice: 2500,
        }],
      },
    }));
    expect(response.status).toBe(201);
    const order = await parseJsonResponse<{ data: { customerId: string | null } }>(response);
    expect(order.data.customerId).toBeNull();
  });

  it("does not let a guest read credential create a fulfillment record", async () => {
    const entityId = await createSellableProduct();
    const cart = await createGuestCart();
    const order = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 2500,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2500,
        metadata: { cartId: cart.id },
        lineItems: [{
          entityId,
          entityType: "product",
          title: "Round 3 Product",
          quantity: 1,
          unitPrice: 2500,
          totalPrice: 2500,
        }],
      },
      testActor,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) throw order.error;

    const injectedFulfillment = await server.fetch(jsonRequest(
      `http://localhost/api/orders/${order.value.id}/fulfillments`,
      {
        method: "POST",
        secret: cart.secret,
        body: {
          lineItems: [{ orderLineItemId: order.value.lineItems[0]!.id, quantity: 1 }],
          carrier: "EvilCo",
          trackingNumber: "FAKE-TRACKING",
        },
      },
    ));
    expect(injectedFulfillment.status).toBe(403);
  });

  it("accepts the cart secret only from the request header", async () => {
    const cart = await createGuestCart();

    const queryCredential = await server.fetch(new Request(
      `http://localhost/api/carts/${cart.id}?secret=${encodeURIComponent(cart.secret)}`,
      { headers: { "x-store-id": STORE_ID } },
    ));
    expect(queryCredential.status).toBe(403);

    const headerCredential = await server.fetch(jsonRequest(
      `http://localhost/api/carts/${cart.id}`,
      { secret: cart.secret },
    ));
    expect(headerCredential.status).toBe(200);
  });

  it("keeps authenticated checkout on the actor organization without a default org", async () => {
    const isolated = await createTestServer({
      auth: {
        storeResolver: () => MULTI_STORE_ID,
        defaultOrganizationId: "",
      },
    });
    try {
      await isolated.kernel.services.organization.create({
        id: MULTI_STORE_ID,
        name: "Round 3 Multi Store",
        slug: "round3-multistore",
      });
      const actor: Actor = { ...customerActor, organizationId: MULTI_STORE_ID };
      const staff: Actor = { ...testActor, organizationId: MULTI_STORE_ID };
      const product = await isolated.kernel.services.catalog.create(
        {
          type: "product",
          slug: `round3-multistore-${crypto.randomUUID()}`,
          status: "active",
          attributes: { title: "Multi-store Product" },
        },
        staff,
      );
      expect(product.ok).toBe(true);
      if (!product.ok) throw product.error;
      await isolated.kernel.services.pricing.setBasePrice(
        { entityId: product.value.id, currency: "USD", amount: 2500 },
        staff,
      );
      const warehouse = await isolated.kernel.services.inventory.createWarehouse(
        { name: "Multi-store Warehouse", code: `R3-MS-${crypto.randomUUID()}` },
        staff,
      );
      expect(warehouse.ok).toBe(true);
      await isolated.kernel.services.inventory.adjust(
        {
          entityId: product.value.id,
          warehouseId: warehouse.ok ? warehouse.value.id : undefined,
          adjustment: 10,
          reason: "round 3 multi-store checkout fixture",
        },
        staff,
      );

      const cartResponse = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/carts",
        body: { currency: "USD" },
        actor,
      });
      expect(cartResponse.status).toBe(201);
      const cart = await parseJsonResponse<{ data: { id: string } }>(cartResponse);
      const itemResponse = await makeRequest(isolated.server, {
        method: "POST",
        url: `http://localhost/api/carts/${cart.data.id}/items`,
        body: { entityId: product.value.id, quantity: 1 },
        actor,
      });
      expect(itemResponse.status).toBe(201);

      const checkout = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/checkout",
        body: { cartId: cart.data.id, paymentMethodId: "test-payments" },
        actor,
      });
      expect(checkout.status).toBe(201);
    } finally {
      await isolated.cleanup();
    }
  });

  it("allows an authenticated customer to read their order on the direct route", async () => {
    const entityId = await createSellableProduct();
    const customer = await kernel.services.customers.getByUserId(
      customerActor.userId!,
      customerActor,
    );
    expect(customer.ok).toBe(true);
    if (!customer.ok) throw customer.error;

    const order = await kernel.services.orders.create(
      {
        customerId: customer.value.id,
        currency: "USD",
        subtotal: 2500,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2500,
        lineItems: [{
          entityId,
          entityType: "product",
          title: "Round 3 Product",
          quantity: 1,
          unitPrice: 2500,
          totalPrice: 2500,
        }],
      },
      testActor,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) throw order.error;

    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${order.value.orderNumber}`,
      actor: customerActor,
    });
    expect(response.status).toBe(200);
  });
});
