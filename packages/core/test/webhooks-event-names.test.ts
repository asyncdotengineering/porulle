import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import type { AfterHook } from "../src/kernel/hooks/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

/**
 * Webhook delivery builds event names as `${HookContext.context.moduleName}.${operation}`
 * (see modules/webhooks/hook.ts). Hook channels use names like `catalog.afterCreate` but
 * the enqueue key is e.g. `catalog.create`, `cart.addItem`.
 */
describe("webhook-style event names (moduleName + operation)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;
  const seen: string[] = [];

  const actor: Actor = {
    type: "user",
    userId: "webhook-event-names-1",
    email: "wen@test.local",
    name: "Webhook Event Names",
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "admin",
    permissions: ["*:*"],
  };

  function track(hookKey: string): void {
    kernel.hooks.append(
      hookKey,
      (async ({ operation, context }) => {
        const mod = context.context.moduleName;
        seen.push(`${String(mod ?? "unknown")}.${operation}`);
      }) as AfterHook<unknown>,
    );
  }

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
    track("catalog.afterCreate");
    track("cart.afterAddItem");
    track("customers.afterCreate");
    track("pricing.afterCreate");
    track("promotions.afterCreate");
    track("fulfillment.afterCreate");
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    seen.length = 0;
    await cleanup();
  });

  it("catalog.create is not unknown.create", async () => {
    const res = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `wh-catalog-${Date.now()}`,
        attributes: { locale: "en", title: "WH Catalog" },
      },
      actor,
    );
    expect(res.ok).toBe(true);
    expect(seen.some((e) => e.startsWith("unknown."))).toBe(false);
    expect(seen).toContain("catalog.create");
  });

  it("cart.addItem is not unknown.addItem", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `wh-cart-ent-${Date.now()}`,
        attributes: { locale: "en", title: "WH Cart Entity" },
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
    expect(seen.some((e) => e.startsWith("unknown."))).toBe(false);
    expect(seen).toContain("cart.addItem");
  });

  it("customers.create is not unknown.create", async () => {
    const res = await kernel.services.customers.getByUserId(
      `u-wh-${Date.now()}`,
      actor,
    );
    expect(res.ok).toBe(true);
    expect(seen.some((e) => e.startsWith("unknown."))).toBe(false);
    expect(seen).toContain("customers.create");
  });

  it("pricing.create is not unknown.create", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `wh-price-ent-${Date.now()}`,
        attributes: { locale: "en", title: "WH Price Entity" },
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const res = await kernel.services.pricing.setBasePrice(
      {
        entityId: entity.value.id,
        currency: "USD",
        amount: 999,
      },
      actor,
    );
    expect(res.ok).toBe(true);
    expect(seen.some((e) => e.startsWith("unknown."))).toBe(false);
    expect(seen).toContain("pricing.create");
  });

  it("promotions.create is not unknown.create", async () => {
    const res = await kernel.services.promotions.create(
      {
        name: "WH Promo",
        type: "percentage_off_order",
        value: 10,
      },
      actor,
    );
    expect(res.ok).toBe(true);
    expect(seen.some((e) => e.startsWith("unknown."))).toBe(false);
    expect(seen).toContain("promotions.create");
  });

  it("fulfillment.create is not unknown.create", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `wh-ful-ent-${Date.now()}`,
        attributes: { locale: "en", title: "WH Fulfillment Entity" },
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
    expect(seen.some((e) => e.startsWith("unknown."))).toBe(false);
    expect(seen).toContain("fulfillment.create");
  });
});
