import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";
import type { Actor } from "../src/auth/types.js";
import { customers } from "../src/modules/customers/schema.js";

/**
 * Red-team round 6, breach 4 (`vapt/redteam-rbac-guest-report.md`): a cart
 * secret let a caller email an order's full invoice to any address they chose.
 * The secret already authorized reading the order; a caller-supplied `to`
 * turned that read into delivery, so a leaked secret exfiltrated items, totals
 * and shipping address to a third party and left nothing in the shopper's
 * inbox.
 *
 * The destination now comes from the order, not from the caller. Only staff
 * holding org-wide `orders:read` may name a different recipient.
 */

const STORE_ID = "org_default";
const CUSTOMER_EMAIL = "shopper@example.com";
const ATTACKER = "attacker@evil.example";

const customerActor: Actor = {
  type: "user",
  userId: "invoice-customer-user",
  email: CUSTOMER_EMAIL,
  name: "Invoice Shopper",
  vendorId: null,
  organizationId: STORE_ID,
  role: "customer",
  permissions: ["catalog:read", "orders:create", "orders:read:own", "customers:read:self"],
};

describe("invoice email goes to the order's own address", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  const dispatched: string[] = [];

  beforeAll(async () => {
    const result = await createTestServer({
      auth: {
        allowTestActor: true,
        defaultOrganizationId: STORE_ID,
        requireEmailVerification: false,
        customerPermissions: [
          "catalog:read",
          "cart:create",
          "cart:read",
          "cart:update",
          "orders:create",
          "orders:read:own",
          "customers:read:self",
        ],
        storeResolver: (request: Request) => request.headers.get("x-store-id") ?? STORE_ID,
      },
      email: {
        async send(input: { to: string }) {
          dispatched.push(input.to);
        },
      } as never,
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
    await kernel.services.inventory.createWarehouse({ name: "Main", code: `M${Date.now() % 100000}` }, testActor);
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: {
        type: "product",
        slug: `inv-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        status: "active",
        metadata: { title: "Saree", basePrice: 2000 },
      },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createOrder(customerId?: string): Promise<string> {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "LKR",
        subtotal: 2000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 2000,
        ...(customerId !== undefined ? { customerId } : {}),
        lineItems: [
          { entityId, entityType: "product", title: "Saree", quantity: 1, unitPrice: 2000, totalPrice: 2000 },
        ],
      },
      actor: testActor,
    });
    expect(res.status).toBe(201);
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createCustomer(): Promise<string> {
    const created = await kernel.services.customers.getByUserId(customerActor.userId, testActor);
    expect(created.ok).toBe(true);
    await kernel.database.db
      .update(customers)
      .set({ email: CUSTOMER_EMAIL })
      .where(eq(customers.id, created.value.id));
    return created.value.id as string;
  }

  async function guestOrderWithSecret(): Promise<{ orderId: string; secret: string }> {
    const entityId = await createEntity();
    await kernel.services.inventory.adjust({ entityId, adjustment: 5, reason: "stock" }, testActor);

    const cartRes = await server.fetch(
      new Request("http://localhost/api/carts", {
        method: "POST",
        headers: { "content-type": "application/json", "x-store-id": STORE_ID },
        body: JSON.stringify({ currency: "USD" }),
      }),
    );
    expect(cartRes.status).toBe(201);
    const cart = (await parseJsonResponse<{ data: { id: string; secret: string } }>(cartRes)).data;

    await server.fetch(
      new Request(`http://localhost/api/carts/${cart.id}/items`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-store-id": STORE_ID,
          "x-cart-secret": cart.secret,
        },
        body: JSON.stringify({ entityId, quantity: 1 }),
      }),
    );

    const checkout = await server.fetch(
      new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-store-id": STORE_ID,
          "x-cart-secret": cart.secret,
        },
        body: JSON.stringify({
          cartId: cart.id,
          paymentMethodId: "test-payments",
          currency: "USD",
          idempotencyKey: `inv-${crypto.randomUUID()}`,
        }),
      }),
    );
    expect(checkout.status).toBe(201);
    const order = (await parseJsonResponse<{ data: { id: string } }>(checkout)).data;
    return { orderId: order.id, secret: cart.secret };
  }

  function emailInvoiceAsGuest(orderId: string, to: string, secret: string) {
    return server.fetch(
      new Request(`http://localhost/api/orders/${orderId}/invoice/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-store-id": STORE_ID,
          "x-cart-secret": secret,
        },
        body: JSON.stringify({ to }),
      }),
    );
  }

  function emailInvoice(orderId: string, to: string, actor: Actor) {
    return makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${orderId}/invoice/email`,
      body: { to },
      actor,
    });
  }

  it("refuses to redirect a customer's invoice to an address that is not on the order", async () => {
    const customerId = await createCustomer();
    const orderId = await createOrder(customerId);

    dispatched.length = 0;
    const response = await emailInvoice(orderId, ATTACKER, customerActor);
    expect(response.status).toBe(403);
    expect(dispatched).toEqual([]);
  });

  it("still delivers to the address on the order", async () => {
    const customerId = await createCustomer();
    const orderId = await createOrder(customerId);

    dispatched.length = 0;
    const response = await emailInvoice(orderId, CUSTOMER_EMAIL, customerActor);
    expect(response.status).toBe(200);
    expect(dispatched).toEqual([CUSTOMER_EMAIL]);

    const body = await parseJsonResponse<{ data: { to: string } }>(response);
    expect(body.data.to).toBe(CUSTOMER_EMAIL);
  });

  it("refuses a cart-secret bearer redirecting the invoice off the order", async () => {
    const { orderId, secret } = await guestOrderWithSecret();

    dispatched.length = 0;
    const response = await emailInvoiceAsGuest(orderId, ATTACKER, secret);
    expect(response.status).not.toBe(200);
    expect(dispatched).toEqual([]);
  });

  it("still renders for a cart-secret bearer, which the secret already grants", async () => {
    const { orderId, secret } = await guestOrderWithSecret();

    const response = await server.fetch(
      new Request(`http://localhost/api/orders/${orderId}/invoice.html`, {
        headers: { "x-store-id": STORE_ID, "x-cart-secret": secret },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("lets staff holding org-wide orders:read name a recipient", async () => {
    const customerId = await createCustomer();
    const orderId = await createOrder(customerId);

    dispatched.length = 0;
    const response = await emailInvoice(orderId, "accounts@merchant.example", testActor);
    expect(response.status).toBe(200);
    expect(dispatched).toEqual(["accounts@merchant.example"]);
  });

  it("still renders the invoice for a self-service caller", async () => {
    const customerId = await createCustomer();
    const orderId = await createOrder(customerId);

    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}/invoice.html`,
      actor: customerActor,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Saree");
  });
});
