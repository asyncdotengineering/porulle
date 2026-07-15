import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID, ensureDefaultOrg } from "../src/auth/org.js";
import { organization } from "../src/auth/auth-schema.js";
import { warehouses } from "../src/modules/inventory/schema.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import type { Actor } from "../src/auth/types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import type { Kernel } from "../src/runtime/kernel.js";

/**
 * SEC-12 — cancelling an order must release inventory in the order's org,
 * not the deprecated default org fallback.
 */
const ORG_B = "org_sec12_b";

const actorB: Actor = {
  type: "user",
  userId: "sec12-b-staff",
  email: "b@sec12.test",
  name: "Org B Staff",
  vendorId: null,
  organizationId: ORG_B,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:read",
    "inventory:adjust",
    "inventory:read",
    "orders:create",
    "orders:read",
    "orders:update",
    "orders:manage",
  ],
};

describe("SEC-12 — order cancel releases inventory in the order org", () => {
  let kernel: Kernel;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);

    const db = kernel.database.db as DrizzleDatabase;
    await ensureDefaultOrg(db);
    await db.insert(organization).values({
      id: ORG_B,
      name: "SEC-12 Org B",
      slug: "sec12-b",
      createdAt: new Date(),
    });
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  it("cancelling an Org-B order releases Org-B stock and creates no default-org warehouse", async () => {
    const db = kernel.database.db as DrizzleDatabase;

    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `sec12-entity-${Date.now()}`,
        attributes: { title: "SEC-12 probe" },
        metadata: {},
      },
      actorB,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const wh = await kernel.services.inventory.createWarehouse(
      { name: "Org B Warehouse", code: `SEC12-${Date.now()}` },
      actorB,
    );
    expect(wh.ok).toBe(true);
    if (!wh.ok) return;

    const adjust = await kernel.services.inventory.adjust(
      {
        entityId: entity.value.id,
        warehouseId: wh.value.id,
        adjustment: 10,
        reason: "seed",
      },
      actorB,
    );
    expect(adjust.ok).toBe(true);

    const order = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 500,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 500,
        metadata: {},
        lineItems: [
          {
            entityId: entity.value.id,
            entityType: "product",
            title: "SEC-12 probe",
            quantity: 5,
            unitPrice: 100,
            totalPrice: 500,
          },
        ],
      },
      actorB,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const reserve = await kernel.services.inventory.reserve(
      {
        entityId: entity.value.id,
        quantity: 5,
        orderId: order.value.id,
        warehouseId: wh.value.id,
      },
      actorB,
    );
    expect(reserve.ok).toBe(true);

    const levelsBefore = await kernel.services.inventory.getLevelsByEntityId(
      entity.value.id,
      undefined,
      actorB,
    );
    expect(levelsBefore.ok).toBe(true);
    if (!levelsBefore.ok) return;
    expect(levelsBefore.value[0]!.quantityReserved).toBe(5);
    expect(levelsBefore.value[0]!.quantityOnHand - levelsBefore.value[0]!.quantityReserved).toBe(5);

    const defaultWarehousesBefore = await db
      .select()
      .from(warehouses)
      .where(eq(warehouses.organizationId, DEFAULT_ORG_ID));
    expect(defaultWarehousesBefore).toHaveLength(0);

    const cancelled = await kernel.services.orders.cancel(
      order.value.id,
      actorB,
      "sec12_probe",
    );
    expect(cancelled.ok).toBe(true);

    const levelsAfter = await kernel.services.inventory.getLevelsByEntityId(
      entity.value.id,
      undefined,
      actorB,
    );
    expect(levelsAfter.ok).toBe(true);
    if (!levelsAfter.ok) return;
    expect(levelsAfter.value[0]!.quantityReserved).toBe(0);
    expect(levelsAfter.value[0]!.quantityOnHand).toBe(10);

    const defaultWarehousesAfter = await db
      .select()
      .from(warehouses)
      .where(eq(warehouses.organizationId, DEFAULT_ORG_ID));
    expect(defaultWarehousesAfter).toHaveLength(0);
  });
});
