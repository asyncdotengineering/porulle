import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

/**
 * What a cart line costs when nobody said.
 *
 * `addItem` used to write `processed.unitPriceSnapshot ?? 1000` — a literal — whenever no
 * `cart.beforeAddItem` hook supplied a price. Nothing in the response, the logs or the schema said
 * the number was invented, so an integrator learned it by comparing a cart against a catalog. It
 * was found exactly that way: a deployed cart reading 1000 against a catalog priced 14500–22800.
 *
 * Three directions, because the fix is not "throw" but "ask the pricing step, and refuse only when
 * it has no answer":
 *
 *   1. a priced entity, no hook   → the line carries the PRICE, which the literal hid;
 *   2. an unpriced entity, no hook → the add is REFUSED and the refusal names the price;
 *   3. a hook that supplies one   → the hook still wins, so bespoke pricing keeps its seam.
 *
 * Direction 1 is the one that makes this a fix rather than a break: an integrator with a priced
 * catalog gets a correct cart on upgrade instead of an error telling them to write a hook.
 */

const actor = {
  type: "user",
  userId: "cart-pricing-actor",
  email: "cart-pricing@example.com",
  name: "Cart Pricing Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:read",
    "catalog:update",
    "pricing:manage",
    "cart:create",
    "cart:read",
    "cart:update",
  ],
} as any;

describe("cart.addItem – where the unit price comes from", () => {
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

  async function createEntity(slug: string) {
    const created = await kernel.services.catalog.create(
      { type: "course", slug, attributes: { title: slug }, metadata: {} },
      actor,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;
    return created.value;
  }

  async function createCart() {
    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) throw cart.error;
    return cart.value;
  }

  it("prices the line from the pricing step when no hook supplies one", async () => {
    const entity = await createEntity("cart-pricing-priced");
    const price = await kernel.services.pricing.setBasePrice(
      { entityId: entity.id, currency: "USD", amount: 14500 },
      actor,
    );
    expect(price.ok).toBe(true);

    const cart = await createCart();
    const added = await kernel.services.cart.addItem(
      { cartId: cart.id, entityId: entity.id, quantity: 1 },
      actor,
    );

    expect(added.ok).toBe(true);
    if (!added.ok) return;
    // 1000 here means the literal is back; anything else that is not 14500 means the line was
    // priced by something other than the pricing step.
    expect(added.value.unitPriceSnapshot).toBe(14500);
    expect(added.value.currency).toBe("USD");
  });

  it("refuses the add when no price can be resolved, and names the price", async () => {
    const entity = await createEntity("cart-pricing-unpriced");
    const cart = await createCart();

    const added = await kernel.services.cart.addItem(
      { cartId: cart.id, entityId: entity.id, quantity: 1 },
      actor,
    );

    expect(added.ok).toBe(false);
    if (added.ok) return;
    // The refusal has to be actionable: "invalid input" sends an integrator to the request body,
    // which is not where the problem is.
    const message = String((added.error as { message?: unknown }).message ?? "");
    expect(message).toMatch(/price/i);
    expect(message).toContain(entity.id);

    const fetched = await kernel.services.cart.getById(cart.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    // A refusal that still writes the line is not a refusal.
    expect(fetched.value.lineItems).toHaveLength(0);
  });

  it("lets a cart.beforeAddItem hook override the resolved price", async () => {
    const { config, cleanup: hookCleanup } = await createPGliteTestConfig();
    const hookedKernel = createKernel({
      ...config,
      hooks: {
        ...(config as { hooks?: Record<string, unknown> }).hooks,
        "cart.beforeAddItem": [
          ({ data }: { data: Record<string, unknown> }) => ({
            ...data,
            unitPriceSnapshot: 999,
          }),
        ],
      },
    } as typeof config);

    try {
      const created = await hookedKernel.services.catalog.create(
        { type: "course", slug: "cart-pricing-hooked", attributes: { title: "hooked" }, metadata: {} },
        actor,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await hookedKernel.services.pricing.setBasePrice(
        { entityId: created.value.id, currency: "USD", amount: 14500 },
        actor,
      );

      const cart = await hookedKernel.services.cart.create({ currency: "USD" }, actor);
      expect(cart.ok).toBe(true);
      if (!cart.ok) return;

      const added = await hookedKernel.services.cart.addItem(
        { cartId: cart.value.id, entityId: created.value.id, quantity: 1 },
        actor,
      );
      expect(added.ok).toBe(true);
      if (!added.ok) return;
      // The hook wins over the pricing step, so an integrator with bespoke pricing keeps its seam.
      expect(added.value.unitPriceSnapshot).toBe(999);
    } finally {
      await hookCleanup();
    }
  });
});
