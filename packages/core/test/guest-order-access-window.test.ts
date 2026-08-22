import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";
import { orders } from "../src/modules/orders/schema.js";
import { customers } from "../src/modules/customers/schema.js";
import type { Actor } from "../src/auth/types.js";
import { parseAccessWindow, windowedGuestOrderAccess } from "../src/modules/orders/guest-access.js";

/**
 * Round 6, breach 5. The cart secret is a bearer credential with no lifetime:
 * it read a placed order forever, because the guest branch of
 * `authorizeOrderRead` re-authorized by calling back into `cart.getById` and
 * nothing consulted time at all.
 *
 * Entropy was never the exposure — 122 bits is not guessed. A secret that
 * escaped through a referrer, a shared link or a log line was, and it worked
 * indefinitely. Guest access is now bounded to a window after placement, behind
 * a strategy so the policy has one home.
 *
 * See the board document "Decision: the cart secret gets a bounded order-read
 * window" for why seven days rather than Vendure's two hours.
 */

const STORE_ID = "org_default";
const FORBIDDEN = "You do not have access to this resource.";

const customerActor: Actor = {
  type: "user",
  userId: "window-customer-user",
  email: "window-shopper@example.com",
  name: "Window Shopper",
  vendorId: null,
  organizationId: STORE_ID,
  role: "customer",
  permissions: ["catalog:read", "orders:create", "orders:read:own", "customers:read:self"],
};

describe("a guest's order read is bounded to a window after placement", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;

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
    });
    server = result.server;
    kernel = result.kernel;
    cleanup = result.cleanup;
    await kernel.services.inventory.createWarehouse(
      { name: "Main", code: `M${Date.now() % 100000}` },
      testActor,
    );
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
        slug: `win-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        status: "active",
        metadata: { title: "Kurta", basePrice: 3000 },
      },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function guestOrder(): Promise<{ orderId: string; secret: string }> {
    const entityId = await createEntity();
    await kernel.services.inventory.adjust({ entityId, adjustment: 5, reason: "stock" }, testActor);

    const headers = { "content-type": "application/json", "x-store-id": STORE_ID };
    const cartRes = await server.fetch(
      new Request("http://localhost/api/carts", {
        method: "POST",
        headers,
        body: JSON.stringify({ currency: "USD" }),
      }),
    );
    expect(cartRes.status).toBe(201);
    const cart = (await parseJsonResponse<{ data: { id: string; secret: string } }>(cartRes)).data;

    const withSecret = { ...headers, "x-cart-secret": cart.secret };
    await server.fetch(
      new Request(`http://localhost/api/carts/${cart.id}/items`, {
        method: "POST",
        headers: withSecret,
        body: JSON.stringify({ entityId, quantity: 1 }),
      }),
    );
    const checkout = await server.fetch(
      new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: withSecret,
        body: JSON.stringify({
          cartId: cart.id,
          paymentMethodId: "test-payments",
          currency: "USD",
          idempotencyKey: `win-${crypto.randomUUID()}`,
        }),
      }),
    );
    expect(checkout.status).toBe(201);
    const order = (await parseJsonResponse<{ data: { id: string } }>(checkout)).data;
    return { orderId: order.id, secret: cart.secret };
  }

  function readOrder(orderId: string, secret: string) {
    return server.fetch(
      new Request(`http://localhost/api/orders/${orderId}`, {
        headers: { "x-store-id": STORE_ID, "x-cart-secret": secret },
      }),
    );
  }

  async function backdate(orderId: string, days: number): Promise<void> {
    await kernel.database.db
      .update(orders)
      .set({ placedAt: sql`now() - interval '${sql.raw(String(days))} days'` })
      .where(eq(orders.id, orderId));
  }

  it("reads the order inside the window", async () => {
    const { orderId, secret } = await guestOrder();
    const response = await readOrder(orderId, secret);
    expect(response.status).toBe(200);
  });

  it("refuses the same secret once the window has passed", async () => {
    const { orderId, secret } = await guestOrder();
    await backdate(orderId, 8);

    const response = await readOrder(orderId, secret);
    expect(response.status).toBe(403);
  });

  it("does not leak that the secret was valid but stale", async () => {
    const { orderId, secret } = await guestOrder();
    await backdate(orderId, 8);

    const stale = await readOrder(orderId, secret);
    const wrong = await readOrder(orderId, crypto.randomUUID());

    expect(stale.status).toBe(wrong.status);
    const staleBody = await parseJsonResponse<{ error: { code: string; message: string } }>(stale);
    const wrongBody = await parseJsonResponse<{ error: { code: string; message: string } }>(wrong);
    expect(staleBody.error.message).toBe(wrongBody.error.message);
    expect(staleBody.error.code).toBe(wrongBody.error.code);
    expect(staleBody.error.message).toBe(FORBIDDEN);
  });

  it("leaves an authenticated customer's own order reachable past the window", async () => {
    const entityId = await createEntity();
    const profile = await kernel.services.customers.getByUserId(customerActor.userId, testActor);
    expect(profile.ok).toBe(true);
    await kernel.database.db
      .update(customers)
      .set({ email: customerActor.email })
      .where(eq(customers.id, profile.value.id));

    const created = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "USD",
        subtotal: 3000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 3000,
        customerId: profile.value.id,
        lineItems: [
          { entityId, entityType: "product", title: "Kurta", quantity: 1, unitPrice: 3000, totalPrice: 3000 },
        ],
      },
      actor: testActor,
    });
    expect(created.status).toBe(201);
    const orderId = (await parseJsonResponse<{ data: { id: string } }>(created)).data.id;
    await backdate(orderId, 400);

    const response = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${orderId}`,
      actor: customerActor,
    });
    expect(response.status).toBe(200);
  });

  it("bounds the document routes too", async () => {
    const { orderId, secret } = await guestOrder();
    await backdate(orderId, 8);

    const html = await server.fetch(
      new Request(`http://localhost/api/orders/${orderId}/invoice.html`, {
        headers: { "x-store-id": STORE_ID, "x-cart-secret": secret },
      }),
    );
    expect(html.status).toBe(403);

    const email = await server.fetch(
      new Request(`http://localhost/api/orders/${orderId}/invoice/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-store-id": STORE_ID,
          "x-cart-secret": secret,
        },
        body: JSON.stringify({ to: "shopper@example.com" }),
      }),
    );
    expect(email.status).toBe(403);
  });
});

describe("the access window is a configurable seam, not a constant", () => {
  it("honours a strategy supplied by the adopter", async () => {
    const seen: Array<{ elapsedMs: number }> = [];
    const { server, kernel, cleanup } = await createTestServer({
      auth: {
        allowTestActor: true,
        defaultOrganizationId: STORE_ID,
        requireEmailVerification: false,
        storeResolver: (request: Request) => request.headers.get("x-store-id") ?? STORE_ID,
      },
      orders: {
        guestAccessStrategy: {
          canAccessOrder(order: { placedAt: Date }, now: Date) {
            seen.push({ elapsedMs: now.getTime() - new Date(order.placedAt).getTime() });
            return false;
          },
        },
      },
    } as never);

    try {
      await kernel.services.inventory.createWarehouse(
        { name: "Seam", code: `S${Date.now() % 100000}` },
        testActor,
      );
      const entity = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/catalog/entities",
        body: {
          type: "product",
          slug: `seam-${Date.now()}`,
          status: "active",
          metadata: { title: "Seam", basePrice: 1000 },
        },
        actor: testActor,
      });
      const entityId = (await parseJsonResponse<{ data: { id: string } }>(entity)).data.id;
      await kernel.services.inventory.adjust({ entityId, adjustment: 5, reason: "stock" }, testActor);

      const headers = { "content-type": "application/json", "x-store-id": STORE_ID };
      const cartRes = await server.fetch(
        new Request("http://localhost/api/carts", {
          method: "POST",
          headers,
          body: JSON.stringify({ currency: "USD" }),
        }),
      );
      const cart = (await parseJsonResponse<{ data: { id: string; secret: string } }>(cartRes)).data;
      const withSecret = { ...headers, "x-cart-secret": cart.secret };
      await server.fetch(
        new Request(`http://localhost/api/carts/${cart.id}/items`, {
          method: "POST",
          headers: withSecret,
          body: JSON.stringify({ entityId, quantity: 1 }),
        }),
      );
      const checkout = await server.fetch(
        new Request("http://localhost/api/checkout", {
          method: "POST",
          headers: withSecret,
          body: JSON.stringify({
            cartId: cart.id,
            paymentMethodId: "test-payments",
            currency: "USD",
            idempotencyKey: `seam-${crypto.randomUUID()}`,
          }),
        }),
      );
      expect(checkout.status).toBe(201);
      const orderId = (await parseJsonResponse<{ data: { id: string } }>(checkout)).data.id;

      // The default seven-day window would allow this read; the configured
      // strategy refuses it, so the seam is load-bearing.
      const response = await server.fetch(
        new Request(`http://localhost/api/orders/${orderId}`, {
          headers: { "x-store-id": STORE_ID, "x-cart-secret": cart.secret },
        }),
      );
      expect(response.status).toBe(403);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]!.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await cleanup();
    }
  });

  it("refuses a malformed window at configuration time", () => {
    expect(() => windowedGuestOrderAccess("7 days")).toThrow(/Invalid guest order access window/);
    expect(() => windowedGuestOrderAccess("")).toThrow();
    expect(parseAccessWindow("7d")).toBe(7 * 86_400_000);
    expect(parseAccessWindow("2h")).toBe(2 * 3_600_000);
  });
});
