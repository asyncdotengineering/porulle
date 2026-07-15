import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import type { Kernel } from "../src/runtime/kernel.js";
import {
  createTestServer,
  makeRequest,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

// A plain customer: catalog/cart/orders, but NO inventory permissions.
const customerActor: Actor = {
  type: "user",
  userId: "vapt-inv-customer",
  email: "customer@vapt.test",
  name: "VAPT Customer",
  vendorId: null,
  organizationId: "org_default",
  role: "customer",
  permissions: [
    "catalog:read",
    "cart:create",
    "cart:read",
    "cart:update",
    "orders:create",
    "orders:read:own",
    "customers:read:self",
  ],
};

const inventoryStaff: Actor = {
  type: "user",
  userId: "vapt-inv-staff",
  email: "staff@vapt.test",
  name: "VAPT Staff",
  vendorId: null,
  organizationId: "org_default",
  role: "staff",
  permissions: ["inventory:read", "inventory:adjust"],
};

describe("VAPT: inventory authorization cluster", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await createTestServer();
    server = t.server;
    cleanup = t.cleanup;
  });
  afterAll(async () => {
    await cleanup();
  });

  const wh = () => ({ name: "WH", code: `WH-${crypto.randomUUID().slice(0, 8)}` });

  it("INV-05: anonymous cannot create a warehouse", async () => {
    // Raw fetch with NO x-test-actor header = genuinely anonymous (makeRequest
    // would otherwise inject the default staff actor).
    const res = await server.fetch(
      new Request("http://localhost/api/inventory/warehouses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wh()),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("INV-01: a customer cannot create a warehouse", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/inventory/warehouses",
      body: wh(),
      actor: customerActor,
    });
    expect(res.status).toBe(403);
  });

  it("INV-02: a customer cannot list warehouses", async () => {
    const res = await makeRequest(server, {
      method: "GET",
      url: "http://localhost/api/inventory/warehouses",
      actor: customerActor,
    });
    expect(res.status).toBe(403);
  });

  it("INV-03: a customer cannot reserve inventory", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/inventory/reserve",
      body: { entityId: crypto.randomUUID(), quantity: 1 },
      actor: customerActor,
    });
    expect(res.status).toBe(403);
  });

  it("INV-04: a customer cannot release inventory", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/inventory/release",
      body: { entityId: crypto.randomUUID(), quantity: 1 },
      actor: customerActor,
    });
    expect(res.status).toBe(403);
  });

  it("staff with inventory:adjust CAN create a warehouse", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/inventory/warehouses",
      body: wh(),
      actor: inventoryStaff,
    });
    expect(res.status).toBe(201);
  });

  it("read-only staff (inventory:read) cannot create a warehouse", async () => {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/inventory/warehouses",
      body: wh(),
      actor: { ...inventoryStaff, permissions: ["inventory:read"] },
    });
    expect(res.status).toBe(403);
  });
});

describe("VAPT: checkout idempotency-key IDOR (IDOR-01)", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Kernel;
  let cleanup: () => Promise<void>;
  const admin: Actor = { ...testActor, permissions: ["*:*"] };

  beforeAll(async () => {
    const t = await createTestServer();
    server = t.server;
    kernel = t.kernel;
    cleanup = t.cleanup;
  });
  afterAll(async () => {
    await cleanup();
  });

  it("an idempotency key only replays the requester's own order", async () => {
    const custA = (await kernel.services.customers.createWalkIn(
      { userId: "idor-user-a", email: "a@idor.test" },
      admin,
    )) as { ok: boolean; value: { id: string } };
    expect(custA.ok).toBe(true);

    const entity = (await kernel.services.catalog.create(
      { type: "product", slug: `idor-${crypto.randomUUID()}`, attributes: { title: "P" }, metadata: {} },
      admin,
    )) as { ok: boolean; value: { id: string } };
    expect(entity.ok).toBe(true);

    const KEY = "idem-A-secret";
    const order = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 1000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 1000,
        customerId: custA.value.id,
        idempotencyKey: KEY,
        lineItems: [
          { entityId: entity.value.id, entityType: "product", title: "P", quantity: 1, unitPrice: 1000, totalPrice: 1000 },
        ],
      },
      admin,
    );
    expect(order.ok).toBe(true);

    // A different customer replaying A's key must NOT receive A's order.
    const customerB: Actor = {
      type: "user",
      userId: "idor-user-b",
      email: "b@idor.test",
      name: "B",
      vendorId: null,
      organizationId: "org_default",
      role: "customer",
      permissions: ["orders:create", "orders:read:own", "customers:read:self"],
    };
    const asB = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: { cartId: crypto.randomUUID(), currency: "USD", idempotencyKey: KEY, paymentMethodId: "card-mock" },
      actor: customerB,
    });
    expect(asB.status).toBe(409);

    // Staff with org-level customers:read may act for others → replay allowed.
    const asStaff = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/checkout",
      body: { cartId: crypto.randomUUID(), currency: "USD", idempotencyKey: KEY, paymentMethodId: "card-mock" },
      actor: admin,
    });
    expect(asStaff.status).toBe(201);
  });
});
