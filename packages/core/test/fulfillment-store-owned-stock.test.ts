/**
 * A fulfilment deducts only stock the platform owns.
 *
 * Found on a real Shopify store: an entity imported from a connected store mirrors that store's
 * AVAILABLE count (`setAbsolute` from its stock sync). The store decrements its own count when it
 * accepts the order, and the mirror follows; the store's available does not move again when it
 * ships. Core then deducted on fulfilment too, so one sale took two units off the mirror, and the
 * drift grew by one per order.
 *
 * Ways this could pass while proving nothing, written first:
 *   - the skip applies to EVERY entity → the platform-owned row must still deduct;
 *   - the reservation is left held → reserved must return to 0 on both rows;
 *   - the order never reached `fulfilled` → each row asserts the status first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const staff: Actor = {
  type: "user",
  userId: "fulfil-staff-1",
  email: "staff@example.com",
  name: "Fulfilment Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create", "catalog:update", "catalog:read", "catalog:read:unpublished", "catalog:sync",
    "inventory:adjust", "inventory:read", "orders:create", "orders:create:on-behalf", "orders:read",
    "orders:update", "orders:manage",
  ],
};

describe("fulfilment and stock ownership (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const created = await createPGliteTestConfig();
    cleanup = created.cleanup;
    kernel = createKernel(created.config);
  });

  afterAll(async () => {
    await cleanup();
  });

  /** One unit sold and walked to fulfilled; returns the entity's level afterwards. */
  async function sellOneAndFulfil(sourceStoreId: string | undefined): Promise<{ status: string; onHand: number; reserved: number }> {
    const entity = await kernel.services.catalog.create({
      type: "product",
      slug: `fulfil-${sourceStoreId ?? "platform"}-${Date.now()}`,
      attributes: { title: "Handloom Cotton Shirt" },
      metadata: {},
      ...(sourceStoreId !== undefined ? { sourceStoreId } : {}),
    }, staff);
    if (!entity.ok) throw new Error(entity.error.message);
    const entityId = entity.value.id;

    const stocked = await kernel.services.inventory.setAbsolute({ entityId, quantity: 7, reason: "seed" }, staff);
    if (!stocked.ok) throw new Error(stocked.error.message);

    const order = await kernel.services.orders.create({
      currency: "LKR", subtotal: 980000, taxTotal: 0, shippingTotal: 0, discountTotal: 0, grandTotal: 980000, metadata: {},
      lineItems: [{ entityId, entityType: "product", title: "Handloom Cotton Shirt", quantity: 1, unitPrice: 980000, totalPrice: 980000 }],
    }, staff);
    if (!order.ok) throw new Error(order.error.message);
    const reserved = await kernel.services.inventory.reserve({ entityId, quantity: 1, orderId: order.value.id }, staff);
    if (!reserved.ok) throw new Error(reserved.error.message);

    if (sourceStoreId !== undefined) {
      // The store accepted the order and decremented its own count; its stock sync mirrors that.
      const mirrored = await kernel.services.inventory.setAbsolute({ entityId, quantity: 6, reason: "Inventory webhook sync" }, staff);
      if (!mirrored.ok) throw new Error(mirrored.error.message);
    }

    let status = "";
    for (const newStatus of ["confirmed", "processing", "fulfilled"] as const) {
      const changed = await kernel.services.orders.changeStatus({ orderId: order.value.id, newStatus }, staff);
      if (!changed.ok) throw new Error(changed.error.message);
      status = changed.value.status;
    }

    const levels = await kernel.services.inventory.getLevelsByEntityId(entityId, undefined, staff);
    if (!levels.ok || levels.value.length !== 1) throw new Error("expected exactly one inventory level");
    const [level] = levels.value;
    return { status, onHand: level?.quantityOnHand ?? -1, reserved: level?.quantityReserved ?? -1 };
  }

  it("does not deduct stock mirrored from a connected store, and releases its reservation", async () => {
    const after = await sellOneAndFulfil("store-runvae-dev");
    expect(after.status).toBe("fulfilled");
    expect(after).toEqual({ status: "fulfilled", onHand: 6, reserved: 0 });
  });

  it("still deducts stock the platform owns", async () => {
    const after = await sellOneAndFulfil(undefined);
    expect(after).toEqual({ status: "fulfilled", onHand: 6, reserved: 0 });
  });
});
