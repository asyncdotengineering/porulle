import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import type { AfterHook } from "../src/kernel/hooks/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

describe("HookContext.db is non-null for service-fired hooks", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  const actor: Actor = {
    type: "user",
    userId: "hookctx-db-1",
    email: "hcd@test.local",
    name: "Hook DB",
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "admin",
    permissions: ["*:*"],
  };

  function assertDbInHook(hookKey: string): void {
    kernel.hooks.append(
      hookKey,
      (async ({ context }) => {
        await context.db.execute(sql`SELECT 1`);
      }) as AfterHook<unknown>,
    );
  }

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
    assertDbInHook("catalog.afterCreate");
    assertDbInHook("cart.afterAddItem");
    assertDbInHook("customers.afterCreate");
    assertDbInHook("pricing.afterCreate");
    assertDbInHook("promotions.afterCreate");
    assertDbInHook("fulfillment.afterCreate");
    assertDbInHook("orders.afterCreate");
    assertDbInHook("inventory.afterAdjust");
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("catalog.afterCreate", async () => {
    const res = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `db-hook-catalog-${Date.now()}`,
        attributes: { locale: "en", title: "DB Hook Catalog" },
      },
      actor,
    );
    expect(res.ok).toBe(true);
  });

  it("cart.afterAddItem", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `db-hook-cart-ent-${Date.now()}`,
        attributes: { locale: "en", title: "DB Hook Cart" },
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const add = await kernel.services.cart.addItem(
      {
        cartId: cart.value.id,
        entityId: entity.value.id,
        quantity: 1,
      },
      actor,
    );
    expect(add.ok).toBe(true);
  });

  it("customers.afterCreate", async () => {
    const res = await kernel.services.customers.getByUserId(
      `u-db-hook-${Date.now()}`,
      actor,
    );
    expect(res.ok).toBe(true);
  });

  it("pricing.afterCreate", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `db-hook-price-ent-${Date.now()}`,
        attributes: { locale: "en", title: "DB Hook Price" },
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const res = await kernel.services.pricing.setBasePrice(
      {
        entityId: entity.value.id,
        currency: "USD",
        amount: 100,
      },
      actor,
    );
    expect(res.ok).toBe(true);
  });

  it("promotions.afterCreate", async () => {
    const res = await kernel.services.promotions.create(
      {
        name: "DB Hook Promo",
        type: "percentage_off_order",
        value: 5,
      },
      actor,
    );
    expect(res.ok).toBe(true);
  });

  it("fulfillment.afterCreate", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `db-hook-ful-ent-${Date.now()}`,
        attributes: { locale: "en", title: "DB Hook Fulfillment" },
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const order = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 1000,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 1000,
        lineItems: [
          {
            entityId: entity.value.id,
            entityType: "product",
            title: "Line",
            quantity: 1,
            unitPrice: 1000,
            totalPrice: 1000,
          },
        ],
      },
      actor,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const ful = await kernel.services.fulfillment.fulfillOrder(
      order.value.id,
      actor,
    );
    expect(ful.ok).toBe(true);
  });

  it("orders.afterCreate", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `db-hook-order-ent-${Date.now()}`,
        attributes: { locale: "en", title: "DB Hook Order" },
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const order = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 500,
        taxTotal: 0,
        shippingTotal: 0,
        grandTotal: 500,
        lineItems: [
          {
            entityId: entity.value.id,
            entityType: "product",
            title: "Ord Line",
            quantity: 1,
            unitPrice: 500,
            totalPrice: 500,
          },
        ],
      },
      actor,
    );
    expect(order.ok).toBe(true);
  });

  it("inventory.afterAdjust", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `db-hook-inv-ent-${Date.now()}`,
        attributes: { locale: "en", title: "DB Hook Inventory" },
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const adj = await kernel.services.inventory.adjust(
      {
        entityId: entity.value.id,
        adjustment: 3,
        reason: "db-hook-test",
      },
      actor,
    );
    expect(adj.ok).toBe(true);
  });
});
