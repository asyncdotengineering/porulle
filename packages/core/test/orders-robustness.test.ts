import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

// Full permissions actor (staff)
const staffActor = {
  type: "user",
  userId: "orders-staff-1",
  email: "staff@example.com",
  name: "Orders Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "inventory:adjust",
    "inventory:read",
    "orders:create",
    "orders:read",
    "orders:update",
    "cart:create",
    "cart:update",
  ],
} as any;

// Customer actor – can only see own orders
const customerActor = {
  type: "user",
  userId: "00000000-0000-0000-0000-000000000020",
  email: "customer@example.com",
  name: "Customer One",
  vendorId: null,
  organizationId: null,
  role: "customer",
  permissions: [
    "orders:read:own",
    "orders:create",
    "cart:create",
    "cart:update",
  ],
} as any;

// Actor with no order permissions
const noPermActor = {
  type: "user",
  userId: "orders-noperm-1",
  email: "noperm@example.com",
  name: "No Perm",
  vendorId: null,
  organizationId: null,
  role: "customer",
  permissions: ["catalog:read"],
} as any;

function makeLineItem(entityId = "00000000-0000-0000-0000-000000000001") {
  return {
    entityId,
    entityType: "product",
    title: "Test Product",
    quantity: 1,
    unitPrice: 1000,
    totalPrice: 1000,
  };
}

async function createSimpleOrder(
  kernel: ReturnType<typeof createKernel>,
  actor: any,
  overrides: Partial<Parameters<typeof kernel.services.orders.create>[0]> = {},
) {
  // Create a sellable entity first for FK constraint
  const entity = await kernel.services.catalog.create(
    { type: "product", slug: `order-test-${Date.now()}`, attributes: { title: "Order Test Product" }, metadata: {} },
    actor,
  );
  if (!entity.ok) {
    return entity as any; // Return error if entity creation failed
  }

  const result = await kernel.services.orders.create(
    {
      currency: "USD",
      subtotal: 1000,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      grandTotal: 1000,
      metadata: {},
      lineItems: [{ ...makeLineItem(), entityId: entity.value.id }],
      ...overrides,
    },
    actor,
  );
  return result;
}

// ─── Happy Path ────────────────────────────────────────────────────────────────

describe("orders – happy path (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("create order, list by customer, get by orderNumber", async () => {

    // Create a sellable entity first
    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "order-list-test", attributes: { title: "List Test" }, metadata: {} },
      staffActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const customerId = "00000000-0000-0000-0000-000000000001"; // Valid UUID for test customer
    const order = await kernel.services.orders.create(
      {
        customerId,
        currency: "USD",
        subtotal: 1000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 1000,
        metadata: {},
        lineItems: [{ ...makeLineItem(), entityId: entity.value.id }],
      },
      staffActor,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    expect(order.value.orderNumber).toBeDefined();
    expect(order.value.status).toBe("pending");
    expect(order.value.lineItems).toHaveLength(1);

    // List by customer
    const listed = await kernel.services.orders.listByCustomer(customerId, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.items.some((o) => o.id === order.value.id)).toBe(true);

    // Get by order number
    const byNumber = await kernel.services.orders.getByNumber(order.value.orderNumber, staffActor);
    expect(byNumber.ok).toBe(true);
    if (!byNumber.ok) return;
    expect(byNumber.value.id).toBe(order.value.id);
  });

  it("full status progression: pending → confirmed → processing → fulfilled", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const confirmed = await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "confirmed" },
      staffActor,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.status).toBe("confirmed");

    const processing = await kernel.services.orders.changeStatus(
      { orderId: confirmed.value.id, newStatus: "processing" },
      staffActor,
    );
    expect(processing.ok).toBe(true);
    if (!processing.ok) return;
    expect(processing.value.status).toBe("processing");

    const fulfilled = await kernel.services.orders.changeStatus(
      { orderId: processing.value.id, newStatus: "fulfilled" },
      staffActor,
    );
    expect(fulfilled.ok).toBe(true);
    if (!fulfilled.ok) return;
    expect(fulfilled.value.status).toBe("fulfilled");
  });

  it("cancel pending order → status becomes cancelled", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const cancelled = await kernel.services.orders.cancel(order.value.id, staffActor, "user_request");
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.status).toBe("cancelled");
  });

  it("order status history populated correctly", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "confirmed", reason: "payment_received" },
      staffActor,
    );

    const history = await kernel.services.orders.getStatusHistory(order.value.id);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    // At minimum: created (pending→pending) + one transition
    expect(history.value.length).toBeGreaterThanOrEqual(2);

    const createdEntry = history.value[0]!;
    expect(createdEntry.toStatus).toBe("pending");

    const transitionEntry = history.value[1]!;
    expect(transitionEntry.fromStatus).toBe("pending");
    expect(transitionEntry.toStatus).toBe("confirmed");
  });

  it("refund fulfilled order → transitions to refunded", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    // Walk through to fulfilled
    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "confirmed" },
      staffActor,
    );
    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "processing" },
      staffActor,
    );
    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "fulfilled" },
      staffActor,
    );

    const refunded = await kernel.services.orders.refund(order.value.id, staffActor, "customer_refund");
    expect(refunded.ok).toBe(true);
    if (!refunded.ok) return;
    expect(refunded.value.status).toBe("refunded");
  });
});

// ─── Unhappy Path ──────────────────────────────────────────────────────────────

describe("orders – unhappy path (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("invalid transition: fulfilled → processing → returns Err(CommerceInvalidTransitionError)", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "confirmed" },
      staffActor,
    );
    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "processing" },
      staffActor,
    );
    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "fulfilled" },
      staffActor,
    );

    // Now attempt invalid transition fulfilled → processing
    const invalid = await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "processing" },
      staffActor,
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.message).toMatch(/cannot transition/i);
  });

  it("invalid transition: cancelled → confirmed → Err (terminal state)", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "cancelled" },
      staffActor,
    );

    const invalid = await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "confirmed" },
      staffActor,
    );
    expect(invalid.ok).toBe(false);
  });

  it("getById for non-existent ID → Err(CommerceNotFoundError)", async () => {
  
    const result = await kernel.services.orders.getById("00000000-0000-0000-0000-000000000040", staffActor);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });

  it("getByNumber for non-existent number → Err(CommerceNotFoundError)", async () => {
  
    const result = await kernel.services.orders.getByNumber("ORD-999999", staffActor);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });

  it("unauthorized access: customer tries to view other customer's order → Err", async () => {
  
    // Staff creates an order for a different customer
    const order = await createSimpleOrder(kernel, staffActor, { customerId: "00000000-0000-0000-0000-000000000010" });
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    // Customer actor tries to view it (only has orders:read:own)
    const result = await kernel.services.orders.getById(order.value.id, customerActor);
    expect(result.ok).toBe(false);
  });

  it("changeStatus without orders:update permission → Err(CommerceForbiddenError)", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const result = await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "confirmed" },
      noPermActor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Should be a permission error
    expect(result.error.message.toLowerCase()).toMatch(/permission|forbidden|not authorized/i);
  });

  it("create order without orders:create permission → Err(CommerceForbiddenError)", async () => {
  
    const result = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 1000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 1000,
        metadata: {},
        lineItems: [makeLineItem()],
      },
      noPermActor,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.toLowerCase()).toMatch(/permission|forbidden|not authorized/i);
  });

  it("create order with empty lineItems → Err(CommerceValidationError)", async () => {
  
    const result = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 0,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 0,
        metadata: {},
        lineItems: [],
      },
      staffActor,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/line item/i);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────────

describe("orders – edge cases (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("order with null customerId (guest checkout)", async () => {

    // Create a sellable entity first
    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "guest-checkout-test", attributes: { title: "Guest Checkout" }, metadata: {} },
      staffActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const result = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 2000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 2000,
        metadata: {},
        lineItems: [{ ...makeLineItem(), entityId: entity.value.id }],
        // no customerId → guest order
      },
      staffActor,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Guest order: customerId is null or undefined
    expect(result.value.customerId ?? null).toBeNull();
    expect(result.value.status).toBe("pending");
  });

  it("listByCustomer with no matching orders → returns empty items array", async () => {
  
    const result = await kernel.services.orders.listByCustomer("00000000-0000-0000-0000-000000000030", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(0);
  });

  it("list orders with status filter", async () => {
  
    // Create two orders in different states
    const ord1 = await createSimpleOrder(kernel, staffActor);
    const ord2 = await createSimpleOrder(kernel, staffActor);
    expect(ord1.ok).toBe(true);
    expect(ord2.ok).toBe(true);
    if (!ord1.ok || !ord2.ok) return;

    await kernel.services.orders.changeStatus(
      { orderId: ord1.value.id, newStatus: "confirmed" },
      staffActor,
    );
    // ord2 stays pending

    const pendingOrders = await kernel.services.orders.list({ status: "pending" }, staffActor);
    expect(pendingOrders.ok).toBe(true);
    if (!pendingOrders.ok) return;
    const pendingIds = pendingOrders.value.items.map((o) => o.id);
    expect(pendingIds).toContain(ord2.value.id);
    expect(pendingIds).not.toContain(ord1.value.id);
  });

  it("list orders with pagination (page 2)", async () => {
  
    // Create 3 orders
    for (let i = 0; i < 3; i++) {
      await createSimpleOrder(kernel, staffActor);
    }

    const page1 = await kernel.services.orders.list({ page: 1, limit: 2 }, staffActor);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value.items).toHaveLength(2);
    expect(page1.value.pagination.page).toBe(1);

    const page2 = await kernel.services.orders.list({ page: 2, limit: 2 }, staffActor);
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.items).toHaveLength(1);
    expect(page2.value.pagination.page).toBe(2);
  });

  it("cancel with reason → reason stored in status history", async () => {
  
    const order = await createSimpleOrder(kernel, staffActor);
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    await kernel.services.orders.cancel(order.value.id, staffActor, "duplicate_order");

    const history = await kernel.services.orders.getStatusHistory(order.value.id);
    expect(history.ok).toBe(true);
    if (!history.ok) return;

    const cancelEntry = history.value.find((h) => h.toStatus === "cancelled");
    expect(cancelEntry).toBeDefined();
    expect(cancelEntry!.reason).toBe("duplicate_order");
  });

  it("customer can view own order with orders:read:own permission", async () => {

    // Create a sellable entity first
    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "customer-own-order", attributes: { title: "Customer Own" }, metadata: {} },
      staffActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    // Create order owned by customerActor (using valid UUID that matches customerActor.userId)
    const order = await kernel.services.orders.create(
      {
        customerId: "00000000-0000-0000-0000-000000000020", // Matches customerActor.userId
        currency: "USD",
        subtotal: 1000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 1000,
        metadata: {},
        lineItems: [{ ...makeLineItem(), entityId: entity.value.id }],
      },
      staffActor,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    // Customer should be able to view their own order
    const retrieved = await kernel.services.orders.getById(order.value.id, customerActor);
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) return;
    expect(retrieved.value.id).toBe(order.value.id);
  });

  it("multiple line items in a single order", async () => {

    // Create 3 sellable entities first for FK constraint
    const e1 = await kernel.services.catalog.create(
      { type: "product", slug: "multi-item-1", attributes: { title: "Item 1" }, metadata: {} },
      staffActor,
    );
    const e2 = await kernel.services.catalog.create(
      { type: "product", slug: "multi-item-2", attributes: { title: "Item 2" }, metadata: {} },
      staffActor,
    );
    const e3 = await kernel.services.catalog.create(
      { type: "product", slug: "multi-item-3", attributes: { title: "Item 3" }, metadata: {} },
      staffActor,
    );
    expect(e1.ok && e2.ok && e3.ok).toBe(true);
    if (!e1.ok || !e2.ok || !e3.ok) return;

    const result = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 3000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 3000,
        metadata: {},
        lineItems: [
          makeLineItem(e1.value.id),
          makeLineItem(e2.value.id),
          makeLineItem(e3.value.id),
        ],
      },
      staffActor,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lineItems).toHaveLength(3);
  });

  it("getStatusHistory for non-existent order → Err(CommerceNotFoundError)", async () => {
  
    const result = await kernel.services.orders.getStatusHistory("00000000-0000-0000-0000-000000000050");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });
});
