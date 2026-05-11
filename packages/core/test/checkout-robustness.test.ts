import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { runBeforeHooks, runAfterHooks } from "../src/kernel/hooks/executor.js";
import { Ok } from "../src/kernel/result.js";
import type { PaymentAdapter } from "../src/modules/payments/adapter.js";
import {
  applyPromotionCodes,
  authorizePayment,
  calculateShipping,
  calculateTax,
  capturePayment,
  checkInventoryAvailability,
  initiateFulfillment,
  recordAnalyticsEvent,
  reserveInventory,
  resolveCurrentPrices,
  sendConfirmation,
  validateCartNotEmpty,
  validatePaymentMethod,
  type CheckoutData,
} from "../src/hooks/checkout.js";

const actor = {
  type: "user",
  userId: "checkout-actor-1",
  email: "checkout@example.com",
  name: "Checkout Staff",
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
    "customers:update:self",
  ],
} as any;

const mockPaymentAdapter: PaymentAdapter = {
  providerId: "test-payments",
  async createPaymentIntent(params) {
    return Ok({
      id: "pi_test_1",
      status: "requires_capture",
      amount: params.amount,
      currency: params.currency,
      clientSecret: "secret_test",
    });
  },
  async capturePayment() {
    return Ok({ id: "pi_test_1", status: "succeeded", amountCaptured: 1000 });
  },
  async refundPayment() {
    return Ok({ id: "re_test_1", status: "succeeded", amountRefunded: 1000 });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook() {
    return Ok({ id: "evt_test_1", type: "payment.succeeded", data: {} });
  },
};

const failingPaymentAdapter: PaymentAdapter = {
  providerId: "failing-payments",
  async createPaymentIntent() {
    return { ok: false as const, error: new Error("Card declined") } as any;
  },
  async capturePayment() {
    return { ok: false as const, error: new Error("Capture failed") } as any;
  },
  async refundPayment() {
    return { ok: false as const, error: new Error("Refund failed") } as any;
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook() {
    return Ok({ id: "evt_fail_1", type: "payment.failed", data: {} });
  },
};

function makeBlankCheckout(cartId: string, overrides: Partial<CheckoutData> = {}): CheckoutData {
  const base: CheckoutData = {
    checkoutId: "co-test",
    cartId,
    // customerId omitted for guest checkout (can be provided via overrides)
    currency: "USD",
    paymentMethodId: "test-payments",
    lineItems: [],
    subtotal: 0,
    discountTotal: 0,
    taxTotal: 0,
    shippingTotal: 0,
    total: 0,
  };
  return { ...base, ...overrides };
}

function makeContext(kernel: ReturnType<typeof createKernel>) {
  return {
    actor,
    tx: null,
    logger: kernel.logger,
    services: kernel.services as any,
    context: {},
    requestId: crypto.randomUUID(),
    origin: "rest" as const,
    jobs: { enqueue: async () => {} },
    kernel,
  } as any;
}

const beforeHooks = [
  validateCartNotEmpty,
  resolveCurrentPrices,
  checkInventoryAvailability,
  applyPromotionCodes,
  calculateTax,
  calculateShipping,
  validatePaymentMethod,
  authorizePayment,
];

// ─── Unhappy Path – validateCartNotEmpty ──────────────────────────────────────

describe("checkout – validateCartNotEmpty (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({ payments: [mockPaymentAdapter] });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("empty cart → throws CommerceValidationError", async () => {

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    await expect(
      runBeforeHooks([validateCartNotEmpty] as any, checkoutData, "create", ctx),
    ).rejects.toThrow(/empty cart/i);
  });

  it("cart with items → enriches line items with title and entity type", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-validate-item", attributes: { title: "Test Product" }, metadata: { basePrice: 1000 } },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 50, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 1000,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks([validateCartNotEmpty] as any, checkoutData, "create", ctx);

    expect(processed.lineItems).toHaveLength(1);
    expect(processed.lineItems[0]!.entityId).toBe(entity.value.id);
    // Title should be enriched from catalog
    expect(processed.lineItems[0]!.title).toBeDefined();
  });
});

// ─── Unhappy Path – resolveCurrentPrices ──────────────────────────────────────

describe("checkout – resolveCurrentPrices (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({ payments: [mockPaymentAdapter] });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("entity with no price configured → throws CommerceValidationError", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-no-price", attributes: { title: "No Price Product" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 10, reason: "stock" },
      actor,
    );

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    // First hook enriches line items, second should throw because no price is set
    await expect(
      runBeforeHooks([validateCartNotEmpty, resolveCurrentPrices] as any, checkoutData, "create", ctx),
    ).rejects.toThrow(/cannot resolve price/i);
  });
});

// ─── Unhappy Path – checkInventoryAvailability ────────────────────────────────

describe("checkout – checkInventoryAvailability (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({ payments: [mockPaymentAdapter] });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("item out of stock → throws Insufficient stock error", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-out-of-stock", attributes: { title: "Out of Stock" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 500,
    });
    // No inventory adjustment → 0 stock

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    await expect(
      runBeforeHooks(
        [validateCartNotEmpty, resolveCurrentPrices, checkInventoryAvailability] as any,
        checkoutData,
        "create",
        ctx,
      ),
    ).rejects.toThrow(/insufficient stock/i);
  });

  it("item partially in stock (want 5, have 3) → throws", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-partial-stock", attributes: { title: "Partial Stock" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 3, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 500,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    // Want 5, only 3 available
    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 5 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    await expect(
      runBeforeHooks(
        [validateCartNotEmpty, resolveCurrentPrices, checkInventoryAvailability] as any,
        checkoutData,
        "create",
        ctx,
      ),
    ).rejects.toThrow(/insufficient stock/i);
  });
});

// ─── Unhappy Path – validatePaymentMethod ─────────────────────────────────────

describe("checkout – validatePaymentMethod (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({ payments: [mockPaymentAdapter] });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("missing paymentMethodId → throws CommerceValidationError", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-no-pm", attributes: { title: "No PM" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 10, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 1000,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id, { paymentMethodId: "" });
    const ctx = makeContext(kernel);

    await expect(
      runBeforeHooks(
        [
          validateCartNotEmpty,
          resolveCurrentPrices,
          checkInventoryAvailability,
          applyPromotionCodes,
          calculateTax,
          calculateShipping,
          validatePaymentMethod,
        ] as any,
        checkoutData,
        "create",
        ctx,
      ),
    ).rejects.toThrow(/payment method/i);
  });
});

// ─── Unhappy Path – authorizePayment ─────────────────────────────────────────

describe("checkout – authorizePayment (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({ payments: [failingPaymentAdapter] });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("payment provider returns error → throws CommerceValidationError", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-pay-fail", attributes: { title: "Pay Fail" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 10, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 1000,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id, { paymentMethodId: "failing-payments" });
    const ctx = makeContext(kernel);

    await expect(
      runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx),
    ).rejects.toThrow(/payment authorization failed/i);
  });
});

// ─── Happy Path ────────────────────────────────────────────────────────────────

describe("checkout – happy path (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({
      payments: [mockPaymentAdapter],
      shipping: {
        type: "flat",
        flatRate: 500,
        freeShippingThreshold: 5000,
        brackets: [],
        fallbackCost: 500,
      },
    });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("full 8-hook pipeline runs successfully", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-full-pipeline", attributes: { title: "Full Pipeline Item" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 50, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 2500,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 2 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);

    expect(processed.lineItems).toHaveLength(1);
    expect(processed.lineItems[0]!.resolvedUnitPrice).toBe(2500);
    expect(processed.subtotal).toBe(5000);
    expect(processed.paymentIntentId).toBeDefined();
  });

  it("promotion applied correctly reduces discountTotal", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-promo-discount", attributes: { title: "Promo Item" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 50, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 1000,
    });
    await kernel.services.promotions.create({
      code: "SAVE10PCT",
      name: "Save 10 Percent",
      type: "percentage_off_order",
      value: 10,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id, { promotionCodes: ["SAVE10PCT"] });
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);

    expect(processed.subtotal).toBe(1000);
    expect(processed.discountTotal).toBe(100); // 10% of 1000
    expect(processed.appliedPromotions).toHaveLength(1);
    expect(processed.appliedPromotions![0]!.code).toBe("SAVE10PCT");
  });

  it("free shipping threshold reached → freeShipping = true", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-free-shipping", attributes: { title: "Free Shipping Item" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 50, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 6000, // above free shipping threshold
    });
    await kernel.services.promotions.create({
      code: "FREESHIP",
      name: "Free Shipping Promo",
      type: "free_shipping",
      value: 0,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id, { promotionCodes: ["FREESHIP"] });
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);

    expect(processed.freeShipping).toBe(true);
    expect(processed.shippingTotal).toBe(0);
  });

  it("after-hooks: reserveInventory called for each line item after order created", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-after-reserve", attributes: { title: "After Reserve" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 20, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 1500,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 3 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);

    const order = await kernel.services.orders.create(
      {
        currency: processed.currency,
        subtotal: processed.subtotal,
        taxTotal: processed.taxTotal,
        shippingTotal: processed.shippingTotal,
        discountTotal: processed.discountTotal,
        grandTotal: processed.total,
        metadata: { checkoutId: processed.checkoutId },
        lineItems: processed.lineItems.map((li) => ({
          entityId: li.entityId,
          entityType: li.entityType ?? "product",
          title: li.title ?? "Item",
          quantity: li.quantity,
          unitPrice: li.resolvedUnitPrice ?? 0,
          totalPrice: li.resolvedTotal ?? 0,
          ...(li.variantId !== undefined ? { variantId: li.variantId } : {}),
        })),
        ...(processed.customerId !== undefined ? { customerId: processed.customerId } : {}),
      },
      actor,
    );

    expect(order.ok).toBe(true);
    if (!order.ok) return;

    // Check available before after-hooks
    const beforeReserve = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(beforeReserve.ok).toBe(true);
    if (!beforeReserve.ok) return;
    const availableBefore = beforeReserve.value;

    const afterReport = await runAfterHooks(
      [capturePayment, reserveInventory, initiateFulfillment, sendConfirmation, recordAnalyticsEvent],
      null,
      order.value,
      "create",
      ctx,
    );

    expect(afterReport.hasErrors).toBe(false);

    // Available should be reduced by reserved amount (3)
    const afterReserve = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(afterReserve.ok).toBe(true);
    if (!afterReserve.ok) return;
    expect(afterReserve.value).toBe(availableBefore - 3);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────────

describe("checkout – edge cases (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({ payments: [mockPaymentAdapter] });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("checkout with 0-value items (free product)", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-free-product", attributes: { title: "Free Product" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 100, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 0,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);

    expect(processed.subtotal).toBe(0);
    expect(processed.total).toBeGreaterThanOrEqual(0);
  });

  it("checkout with multiple promotions: one valid, one invalid", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-multi-promo", attributes: { title: "Multi Promo" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 50, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 2000,
    });

    // Valid promo
    await kernel.services.promotions.create({
      code: "VALID5",
      name: "Valid 5%",
      type: "percentage_off_order",
      value: 5,
    });
    // Expired promo
    await kernel.services.promotions.create({
      code: "EXPIRED10",
      name: "Expired 10%",
      type: "percentage_off_order",
      value: 10,
      validUntil: new Date("2020-01-01T00:00:00.000Z"),
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id, { promotionCodes: ["VALID5", "EXPIRED10"] });
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);

    // Valid promo applied: 5% of 2000 = 100
    expect(processed.discountTotal).toBe(100);
    expect(processed.appliedPromotions).toHaveLength(1);
    expect(processed.appliedPromotions![0]!.code).toBe("VALID5");
  });

  it("CheckoutData with customerId → gets passed through to order creation", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "co-customer-passthrough", attributes: { title: "Customer PT" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 10, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 1000,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 1 },
      actor,
    );

    const customerId = "00000000-0000-0000-0000-000000000005";
    const checkoutData = makeBlankCheckout(cart.value.id, { customerId });
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);
    expect(processed.customerId).toBe(customerId);

    const orderInput: {
      customerId?: string;
      currency: string;
      subtotal: number;
      taxTotal: number;
      shippingTotal: number;
      discountTotal: number;
      grandTotal: number;
      metadata: Record<string, unknown>;
      lineItems: Array<{
        entityId: string;
        entityType: string;
        variantId?: string;
        title: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
      }>;
    } = {
      currency: processed.currency,
      subtotal: processed.subtotal,
      taxTotal: processed.taxTotal,
      shippingTotal: processed.shippingTotal,
      discountTotal: processed.discountTotal,
      grandTotal: processed.total,
      metadata: {},
      lineItems: processed.lineItems.map((li) => ({
        entityId: li.entityId,
        entityType: li.entityType ?? "product",
        title: li.title ?? "Item",
        quantity: li.quantity,
        unitPrice: li.resolvedUnitPrice ?? 0,
        totalPrice: li.resolvedTotal ?? 0,
      })),
    };
    if (processed.customerId) {
      orderInput.customerId = processed.customerId;
    }
    const order = await kernel.services.orders.create(orderInput, actor);

    expect(order.ok).toBe(true);
    if (!order.ok) return;
    expect(order.value.customerId).toBe(customerId);
  });

  it("line items with null variantId → reserves correctly without variantId", async () => {

    // Use the digitalDownload entity type which has variants disabled
    const entity = await kernel.services.catalog.create(
      {
        type: "digitalDownload",
        slug: "co-null-variant",
        attributes: { title: "Digital Download" },
        metadata: {},
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 100, reason: "stock" },
      actor,
    );
    await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 1500,
    });

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId: entity.value.id, quantity: 2 },
      actor,
    );

    const checkoutData = makeBlankCheckout(cart.value.id);
    const ctx = makeContext(kernel);

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", ctx);

    // variantId should not be set (null in DB means excluded by the hook)
    expect(processed.lineItems[0]!.variantId).toBeUndefined();

    const order = await kernel.services.orders.create(
      {
        currency: processed.currency,
        subtotal: processed.subtotal,
        taxTotal: processed.taxTotal,
        shippingTotal: processed.shippingTotal,
        discountTotal: processed.discountTotal,
        grandTotal: processed.total,
        metadata: {},
        lineItems: processed.lineItems.map((li) => ({
          entityId: li.entityId,
          entityType: li.entityType ?? "product",
          title: li.title ?? "Item",
          quantity: li.quantity,
          unitPrice: li.resolvedUnitPrice ?? 0,
          totalPrice: li.resolvedTotal ?? 0,
          ...(li.variantId !== undefined ? { variantId: li.variantId } : {}),
        })),
      },
      actor,
    );

    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const afterReport = await runAfterHooks(
      [reserveInventory],
      null,
      order.value,
      "create",
      ctx,
    );

    // reserveInventory should succeed for null variantId line items
    expect(afterReport.hasErrors).toBe(false);
  });
});
