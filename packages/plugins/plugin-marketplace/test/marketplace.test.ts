import { describe, expect, it, beforeAll } from "vitest";
import type { PluginTestApp, Actor } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, TEST_ORG_ID } from "@porulle/core/testing";
import { marketplacePlugin } from "../src/index.js";

/** Admin actor with marketplace + core permissions */
const marketplaceAdmin: Actor = {
  type: "user",
  userId: "mkt-admin-1",
  email: "mkt-admin@test.local",
  name: "Marketplace Admin",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "admin",
  permissions: [
    "marketplace:admin",
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "inventory:adjust",
    "orders:create",
    "orders:read",
    "orders:update",
  ],
};

/** Staff actor with core permissions only (no marketplace) */
const coreStaffActor: Actor = {
  type: "user",
  userId: "staff-1",
  email: "staff@example.com",
  name: "Staff",
  vendorId: null,
  organizationId: TEST_ORG_ID,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "inventory:adjust",
    "orders:create",
    "orders:read",
    "orders:update",
  ],
};

describe("marketplace plugin", () => {
  let app: PluginTestApp["app"];
  let kernel: PluginTestApp["kernel"];

  beforeAll(async () => {
    const result = await createPluginTestApp(
      marketplacePlugin({ defaultCommissionRateBps: 1000, defaultPayoutMinimumCents: 0 }),
    );
    app = result.app;
    kernel = result.kernel;
  }, 30_000);

  it("registers expected routes", async () => {
    // Verify a marketplace route is registered by making a request
    const response = await app.request("http://localhost/api/marketplace/vendors", {
      headers: jsonHeaders(marketplaceAdmin),
    });
    expect(response.status).toBe(200);
  });

  it("supports vendor onboarding, order splitting, commission and payout processing", async () => {
    // Create vendors
    const createdVendorAResponse = await app.request("http://localhost/api/marketplace/vendors", {
      method: "POST",
      headers: jsonHeaders(marketplaceAdmin),
      body: JSON.stringify({ name: "Vendor A", commissionRateBps: 1000 }),
    });
    expect(createdVendorAResponse.status).toBe(201);
    const vendorA = (await createdVendorAResponse.json()).data;

    const createdVendorBResponse = await app.request("http://localhost/api/marketplace/vendors", {
      method: "POST",
      headers: jsonHeaders(marketplaceAdmin),
      body: JSON.stringify({ name: "Vendor B", commissionRateBps: 1500 }),
    });
    expect(createdVendorBResponse.status).toBe(201);
    const vendorB = (await createdVendorBResponse.json()).data;

    // Approve vendors
    const approveARes = await app.request(`http://localhost/api/marketplace/vendors/${vendorA.id}/approve`, {
      method: "POST",
      headers: jsonHeaders(marketplaceAdmin),
    });
    expect(approveARes.status).toBe(201);

    const approveBRes = await app.request(`http://localhost/api/marketplace/vendors/${vendorB.id}/approve`, {
      method: "POST",
      headers: jsonHeaders(marketplaceAdmin),
    });
    expect(approveBRes.status).toBe(201);

    // Create catalog entities with vendorId metadata
    const entityA = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "vendor-a-product",
        attributes: { title: "Vendor A Product" },
        metadata: { vendorId: vendorA.id },
      },
      coreStaffActor,
    );
    const entityB = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "vendor-b-product",
        attributes: { title: "Vendor B Product" },
        metadata: { vendorId: vendorB.id },
      },
      coreStaffActor,
    );
    expect(entityA.ok && entityB.ok).toBe(true);
    if (!entityA.ok || !entityB.ok) return;

    // Set up inventory
    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entityA.value.id, adjustment: 10, reason: "stock" },
      coreStaffActor,
    );
    await kernel.services.inventory.adjust(
      { entityId: entityB.value.id, adjustment: 10, reason: "stock" },
      coreStaffActor,
    );

    // Create order — hooks will auto-split into sub-orders
    const order = await kernel.services.orders.create(
      {
        customerId: "c0000000-0000-4000-8000-000000000001",
        currency: "USD",
        subtotal: 18000,
        taxTotal: 1800,
        shippingTotal: 200,
        discountTotal: 0,
        grandTotal: 20000,
        lineItems: [
          {
            entityId: entityA.value.id,
            entityType: "product",
            title: "Vendor A Product",
            quantity: 1,
            unitPrice: 6000,
            totalPrice: 6000,
          },
          {
            entityId: entityB.value.id,
            entityType: "product",
            title: "Vendor B Product",
            quantity: 2,
            unitPrice: 6000,
            totalPrice: 12000,
          },
        ],
      },
      coreStaffActor,
    );

    expect(order.ok).toBe(true);
    if (!order.ok) return;

    // Verify sub-orders were created via the HTTP API
    const subOrdersRes = await app.request(
      `http://localhost/api/marketplace/sub-orders?orderId=${order.value.id}`,
      { headers: jsonHeaders(marketplaceAdmin) },
    );
    expect(subOrdersRes.status).toBe(200);
    const subOrdersBody = await subOrdersRes.json();
    const subOrders = subOrdersBody.data;
    expect(subOrders).toHaveLength(2);

    const vendorASubOrder = subOrders.find((s: { vendorId: string }) => s.vendorId === vendorA.id);
    const vendorBSubOrder = subOrders.find((s: { vendorId: string }) => s.vendorId === vendorB.id);
    // Vendor A: 6000 subtotal, 10% commission = 600
    expect(vendorASubOrder?.subtotal).toBe(6000);
    expect(vendorASubOrder?.commissionAmount).toBe(600);
    // Vendor B: 12000 subtotal, 15% commission = 1800
    expect(vendorBSubOrder?.subtotal).toBe(12000);
    expect(vendorBSubOrder?.commissionAmount).toBe(1800);

    // Advance order status
    await kernel.services.orders.changeStatus({ orderId: order.value.id, newStatus: "confirmed" }, coreStaffActor);
    await kernel.services.orders.changeStatus({ orderId: order.value.id, newStatus: "processing" }, coreStaffActor);

    // Cannot fulfill parent order until all sub-orders are delivered
    await expect(
      kernel.services.orders.changeStatus(
        { orderId: order.value.id, newStatus: "fulfilled" },
        coreStaffActor,
      ),
    ).rejects.toThrow("Cannot fulfill parent order");

    // Mark sub-orders as delivered via HTTP API
    for (const subOrder of subOrders) {
      const statusRes = await app.request(
        `http://localhost/api/marketplace/sub-orders/${subOrder.id}/status`,
        {
          method: "PATCH",
          headers: jsonHeaders(marketplaceAdmin),
          body: JSON.stringify({ status: "delivered" }),
        },
      );
      expect(statusRes.status).toBe(200);
    }

    // Now fulfillment should succeed
    const fulfilled = await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "fulfilled" },
      coreStaffActor,
    );
    expect(fulfilled.ok).toBe(true);

    // Run payout cycle
    const processedPayoutsResponse = await app.request("http://localhost/api/marketplace/payouts/run", {
      method: "POST",
      headers: jsonHeaders(marketplaceAdmin),
    });
    const processedPayouts = await processedPayoutsResponse.json();
    expect(processedPayouts.data.length).toBe(2);
    // runPayoutCycle returns { vendorId, payoutId, netAmount } per vendor
    const vendorAPayout = processedPayouts.data.find((p: Record<string, unknown>) => p.vendorId === vendorA.id);
    const vendorBPayout = processedPayouts.data.find((p: Record<string, unknown>) => p.vendorId === vendorB.id);
    expect(vendorAPayout).toBeTruthy();
    expect(vendorBPayout).toBeTruthy();
    // Vendor A: 6000 sale - 600 commission = 5400 net
    expect(vendorAPayout.netAmount).toBe(5400);
    // Vendor B: 12000 sale - 1800 commission = 10200 net
    expect(vendorBPayout.netAmount).toBe(10200);
  });

  it("core catalog works alongside marketplace plugin", async () => {
    // Verify core services still work when marketplace plugin is installed
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "core-only-product",
        attributes: { title: "Core Only" },
      },
      coreStaffActor,
    );

    expect(entity.ok).toBe(true);
    const listed = await kernel.services.catalog.list({ pagination: { page: 1, limit: 20 } });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.items.some((item) => item.slug === "core-only-product")).toBe(true);
  });
});
