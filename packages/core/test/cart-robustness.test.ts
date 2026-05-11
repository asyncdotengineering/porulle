import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const actor = {
  type: "user",
  userId: "cart-actor-1",
  email: "cart@example.com",
  name: "Cart Staff",
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
    "cart:read",
    "cart:update",
  ],
} as any;

const noPermActor = {
  type: "user",
  userId: "cart-noperm-1",
  email: "noperm@example.com",
  name: "No Perm",
  vendorId: null,
  organizationId: null,
  role: "viewer",
  permissions: ["catalog:read"],
} as any;

async function createProduct(kernel: ReturnType<typeof createKernel>, slug: string, hasVariants = false) {
  // Use course (no variants) or product (with variants) entity type
  const type = hasVariants ? "product" : "course";
  const created = await kernel.services.catalog.create(
    { type, slug, attributes: { title: slug }, metadata: {} },
    actor,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  return created.value;
}

// ─── Happy Path ────────────────────────────────────────────────────────────────

describe("cart – happy path (PGlite-backed)", () => {
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

  it("create cart, add item, get cart with lineItems", async () => {
    const product = await createProduct(kernel, "cart-happy-1");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    expect(cart.value.status).toBe("active");
    expect(cart.value.currency).toBe("USD");

    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 1 },
      actor,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.entityId).toBe(product.id);

    const fetched = await kernel.services.cart.getById(cart.value.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.lineItems).toHaveLength(1);
    expect(fetched.value.lineItems[0]!.entityId).toBe(product.id);
  });

  it("add same entity twice → merges into single line item with accumulated quantity", async () => {
    const product = await createProduct(kernel, "cart-double-add");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 1 },
      actor,
    );
    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 1 },
      actor,
    );

    const fetched = await kernel.services.cart.getById(cart.value.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    // CartItemMatcher merges duplicate items: 1 line item with quantity 2
    expect(fetched.value.lineItems).toHaveLength(1);
    expect(fetched.value.lineItems[0]!.quantity).toBe(2);
  });

  it("update quantity of item", async () => {
    const product = await createProduct(kernel, "cart-update-qty");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 1 },
      actor,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const updated = await kernel.services.cart.updateQuantity(
      { cartId: cart.value.id, itemId: added.value.id, quantity: 5 },
      actor,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.quantity).toBe(5);
  });

  it("remove item from cart", async () => {
    const product = await createProduct(kernel, "cart-remove-item");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 2 },
      actor,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const removed = await kernel.services.cart.removeItem(
      cart.value.id,
      added.value.id,
      actor,
    );
    expect(removed.ok).toBe(true);

    const fetched = await kernel.services.cart.getById(cart.value.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.lineItems).toHaveLength(0);
  });

  it("cart has correct status: active", async () => {

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;
    expect(cart.value.status).toBe("active");
  });

  it("add item with quantity > 1", async () => {
    const product = await createProduct(kernel, "cart-qty-gt-1");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 7 },
      actor,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.quantity).toBe(7);
  });

  it("multiple items in cart", async () => {
    const p1 = await createProduct(kernel, "cart-multi-1");
    const p2 = await createProduct(kernel, "cart-multi-2");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: p1.id, quantity: 2 },
      actor,
    );
    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: p2.id, quantity: 3 },
      actor,
    );

    const fetched = await kernel.services.cart.getById(cart.value.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.lineItems).toHaveLength(2);
  });

  it("markAsCheckedOut changes status to checked_out", async () => {

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const result = await kernel.services.cart.markAsCheckedOut(cart.value.id);
    expect(result.ok).toBe(true);

    const fetched = await kernel.services.cart.getById(cart.value.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.status).toBe("checked_out");
  });
});

// ─── Unhappy Path ──────────────────────────────────────────────────────────────

describe("cart – unhappy path (PGlite-backed)", () => {
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

  it("add item to non-existent cart → Err(CommerceNotFoundError)", async () => {
    const product = await createProduct(kernel, "cart-nonexistent-cart");

    const result = await kernel.services.cart.addItem(
      { cartId: "00000000-0000-0000-0000-000000000001", entityId: product.id, quantity: 1 },
      actor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/cart not found/i);
  });

  it("remove non-existent item from cart → Err(CommerceNotFoundError)", async () => {

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const result = await kernel.services.cart.removeItem(
      cart.value.id,
      "00000000-0000-0000-0000-000000000002",
      actor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });

  it("update quantity to 0 → Err(CommerceValidationError)", async () => {
    const product = await createProduct(kernel, "cart-qty-zero");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 2 },
      actor,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const result = await kernel.services.cart.updateQuantity(
      { cartId: cart.value.id, itemId: added.value.id, quantity: 0 },
      actor,
    );
    expect(result.ok).toBe(false);
  });

  it("add variant-enabled product without variantId → Err(CommerceValidationError)", async () => {

    // The 'product' entity type has variants enabled
    const product = await kernel.services.catalog.create(
      { type: "product", slug: "cart-variant-no-id", attributes: { title: "Variant Product" }, metadata: {} },
      actor,
    );
    expect(product.ok).toBe(true);
    if (!product.ok) return;

    // Create option type + option value, then a variant using the correct API
    const optionType = await kernel.services.catalog.createOptionType(
      { entityId: product.value.id, name: "size" },
      actor,
    );
    expect(optionType.ok).toBe(true);
    if (!optionType.ok) return;

    const optionValue = await kernel.services.catalog.createOptionValue(
      { optionTypeId: optionType.value.id, value: "M" },
      actor,
    );
    expect(optionValue.ok).toBe(true);
    if (!optionValue.ok) return;

    const variant = await kernel.services.catalog.createVariant(
      {
        entityId: product.value.id,
        options: { size: "M" },
      },
      actor,
    );
    expect(variant.ok).toBe(true);

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    // Try to add without variantId even though variants exist
    const result = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.value.id, quantity: 1 },
      actor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.toLowerCase()).toMatch(/variant/i);
  });

  it("add item to non-existent entity → Err(CommerceNotFoundError)", async () => {

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const result = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: "00000000-0000-0000-0000-000000000003", quantity: 1 },
      actor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });

  it("cart:create without permission → Err", async () => {

    const result = await kernel.services.cart.create(
      { customerId: "some-customer", currency: "USD" },
      noPermActor,
    );
    expect(result.ok).toBe(false);
  });

  it("cart:update without permission → Err when adding item", async () => {
    const product = await createProduct(kernel, "cart-noperm-add");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const result = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 1 },
      noPermActor,
    );
    expect(result.ok).toBe(false);
  });

  it("addItem with quantity < 1 → Err(CommerceValidationError)", async () => {
    const product = await createProduct(kernel, "cart-qty-neg");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const result = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: -1 },
      actor,
    );
    expect(result.ok).toBe(false);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────────

describe("cart – edge cases (PGlite-backed)", () => {
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

  it("cart with no customerId (guest cart)", async () => {

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;
    // Guest cart: customerId is null or undefined
    expect(cart.value.customerId ?? null).toBeNull();
    expect(cart.value.status).toBe("active");
  });

  it("addItem with unitPriceSnapshot = 0 (free item)", async () => {
    const product = await createProduct(kernel, "cart-free-item");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const added = await kernel.services.cart.addItem(
      {
        cartId: cart.value.id,
        entityId: product.id,
        quantity: 1,
        unitPriceSnapshot: 0,
      },
      actor,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.unitPriceSnapshot).toBe(0);
  });

  it("get cart after markAsCheckedOut → still retrievable", async () => {

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.markAsCheckedOut(cart.value.id);

    const fetched = await kernel.services.cart.getById(cart.value.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.status).toBe("checked_out");
    expect(fetched.value.id).toBe(cart.value.id);
  });

  it("cannot add item to checked-out cart → Err", async () => {
    const product = await createProduct(kernel, "cart-co-add");

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.markAsCheckedOut(cart.value.id);

    const result = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 1 },
      actor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.toLowerCase()).toMatch(/not active/i);
  });

  it("getById for non-existent cart → Err(CommerceNotFoundError)", async () => {

    const result = await kernel.services.cart.getById("00000000-0000-0000-0000-000000000004", actor);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/not found/i);
  });

  it("abandon cart changes status to abandoned", async () => {

    const cart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const result = await kernel.services.cart.abandon(cart.value.id);
    expect(result.ok).toBe(true);

    const fetched = await kernel.services.cart.getById(cart.value.id, actor);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.status).toBe("abandoned");
  });

  it("merge carts: source items move to target, source becomes merged", async () => {
    const p1 = await createProduct(kernel, "cart-merge-p1");
    const p2 = await createProduct(kernel, "cart-merge-p2");

    const sourceCart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    const targetCart = await kernel.services.cart.create(
      { currency: "USD" },
      actor,
    );
    expect(sourceCart.ok).toBe(true);
    expect(targetCart.ok).toBe(true);
    if (!sourceCart.ok || !targetCart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: sourceCart.value.id, entityId: p1.id, quantity: 2 },
      actor,
    );
    await kernel.services.cart.addItem(
      { cartId: targetCart.value.id, entityId: p2.id, quantity: 1 },
      actor,
    );

    const merged = await kernel.services.cart.merge(
      sourceCart.value.id,
      targetCart.value.id,
      actor,
    );
    expect(merged.ok).toBe(true);

    const target = await kernel.services.cart.getById(targetCart.value.id, actor);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    // Target should now have 2 items (1 original + 1 from source)
    expect(target.value.lineItems).toHaveLength(2);

    const source = await kernel.services.cart.getById(sourceCart.value.id, actor);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.value.status).toBe("merged");
  });

  it("addItem uses cart currency when item currency is not specified", async () => {
    const product = await createProduct(kernel, "cart-currency-inherit");

    const cart = await kernel.services.cart.create(
      { currency: "EUR" },
      actor,
    );
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: product.id, quantity: 1 },
      actor,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.currency).toBe("EUR");
  });
});
