import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { Ok } from "../src/kernel/result.js";
import type { PaymentAdapter } from "../src/modules/payments/adapter.js";
import {
  applyPromotionCodes,
  authorizePayment,
  calculateShipping,
  calculateTax,
  checkInventoryAvailability,
  resolveCurrentPrices,
  validateCartNotEmpty,
  validatePaymentMethod,
  type CheckoutData,
} from "../src/hooks/checkout.js";
import { runBeforeHooks } from "../src/kernel/hooks/executor.js";
import type { Actor } from "../src/auth/types.js";

const actor: Actor = {
  type: "user",
  userId: "cust-1",
  email: "c1@example.com",
  name: "Customer One",
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
};

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

async function createProduct(kernel: ReturnType<typeof createKernel>, slug: string, metadata: Record<string, unknown> = {}) {
  const created = await kernel.services.catalog.create(
    {
      type: "product",
      slug,
      attributes: { title: slug },
      metadata,
    },
    actor as any,
  );
  expect(created.ok).toBe(true);
  if (!created.ok) throw created.error;
  return created.value;
}

describe("phase 3 pricing engine (PGlite-backed)", () => {
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

  it("resolves base price tiers, customer groups, windows, modifiers and breakdown", async () => {
    const product = await createProduct(kernel, "pricing-main");

    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 1000,
      minQuantity: 1,
      maxQuantity: 9,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 800,
      minQuantity: 10,
      maxQuantity: 49,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 600,
      minQuantity: 50,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 700,
      customerGroupId: "wholesale",
      minQuantity: 1,
      maxQuantity: 9,
    });

    await kernel.services.pricing.createModifier({
      name: "VIP 10%",
      type: "percentage_discount",
      value: 10,
      priority: 10,
      customerGroupId: "vip",
    });
    await kernel.services.pricing.createModifier({
      name: "Spring markdown",
      type: "fixed_discount",
      value: 50,
      priority: 20,
      entityId: product.id,
    });

    const q1 = await kernel.services.pricing.resolve({
      entityId: product.id,
      currency: "USD",
      quantity: 1,
      customerGroupIds: ["vip"],
    });
    expect(q1.ok).toBe(true);
    if (!q1.ok) return;
    expect(q1.value.baseAmount).toBe(1000);
    expect(q1.value.finalAmount).toBe(850);
    expect(q1.value.breakdown).toHaveLength(3);
    expect(q1.value.breakdown[1]?.delta).toBe(-100);
    expect(q1.value.breakdown[2]?.delta).toBe(-50);

    const q10 = await kernel.services.pricing.resolve({
      entityId: product.id,
      currency: "USD",
      quantity: 10,
    });
    expect(q10.ok).toBe(true);
    if (!q10.ok) return;
    expect(q10.value.baseAmount).toBe(800);

    const q50 = await kernel.services.pricing.resolve({
      entityId: product.id,
      currency: "USD",
      quantity: 50,
    });
    expect(q50.ok).toBe(true);
    if (!q50.ok) return;
    expect(q50.value.baseAmount).toBe(600);

    const wholesale = await kernel.services.pricing.resolve({
      entityId: product.id,
      currency: "USD",
      quantity: 1,
      customerGroupIds: ["wholesale"],
    });
    expect(wholesale.ok).toBe(true);
    if (!wholesale.ok) return;
    expect(wholesale.value.baseAmount).toBe(700);

    const scheduledProduct = await createProduct(kernel, "pricing-scheduled");
    await kernel.services.pricing.setBasePrice({
      entityId: scheduledProduct.id,
      currency: "USD",
      amount: 2000,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: scheduledProduct.id,
      currency: "USD",
      amount: 1500,
      validFrom: new Date("2026-04-01T00:00:00.000Z"),
    });

    const beforeWindow = await kernel.services.pricing.resolve({
      entityId: scheduledProduct.id,
      currency: "USD",
      quantity: 1,
      timestamp: new Date("2026-03-31T23:59:59.000Z"),
    });
    expect(beforeWindow.ok).toBe(true);
    if (!beforeWindow.ok) return;
    expect(beforeWindow.value.baseAmount).toBe(2000);

    const afterWindow = await kernel.services.pricing.resolve({
      entityId: scheduledProduct.id,
      currency: "USD",
      quantity: 1,
      timestamp: new Date("2026-04-02T00:00:00.000Z"),
    });
    expect(afterWindow.ok).toBe(true);
    if (!afterWindow.ok) return;
    expect(afterWindow.value.baseAmount).toBe(1500);
  });

  it("resolves three pricing tiers correctly at 1-9, 10-49 and 50+", async () => {
    const product = await createProduct(kernel, "pricing-tiers");

    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 1000,
      minQuantity: 1,
      maxQuantity: 9,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 800,
      minQuantity: 10,
      maxQuantity: 49,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 600,
      minQuantity: 50,
    });

    const q1 = await kernel.services.pricing.resolve({ entityId: product.id, currency: "USD", quantity: 1 });
    const q25 = await kernel.services.pricing.resolve({ entityId: product.id, currency: "USD", quantity: 25 });
    const q60 = await kernel.services.pricing.resolve({ entityId: product.id, currency: "USD", quantity: 60 });

    expect(q1.ok && q1.value.baseAmount).toBe(1000);
    expect(q25.ok && q25.value.baseAmount).toBe(800);
    expect(q60.ok && q60.value.baseAmount).toBe(600);
  });
});

describe("phase 3 promotions (PGlite-backed)", () => {
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

  it("validates and applies percentage/fixed promotions with limits and conditions", async () => {
    const product = await createProduct(kernel, "promo-product");

    const tenOff = await kernel.services.promotions.create({
      code: "SAVE10",
      name: "Save 10",
      type: "percentage_off_order",
      value: 10,
      usageLimitTotal: 1,
      conditions: { minimumOrderValue: 1000, customerGroups: ["vip"] },
    });
    expect(tenOff.ok).toBe(true);
    if (!tenOff.ok) return;

    const fixed = await kernel.services.promotions.create({
      code: "LESS200",
      name: "Less 200",
      type: "fixed_off_order",
      value: 200,
      conditions: { minimumQuantity: 2 },
    });
    expect(fixed.ok).toBe(true);

    const expired = await kernel.services.promotions.create({
      code: "OLD",
      name: "Old",
      type: "fixed_off_order",
      value: 100,
      validUntil: new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(expired.ok).toBe(true);

    const valid = await kernel.services.promotions.validate("SAVE10", {
      currency: "USD",
      subtotal: 2000,
      customerGroupIds: ["vip"],
      lineItems: [{ entityId: product.id, entityType: "product", quantity: 2, unitPrice: 1000, totalPrice: 2000 }],
    });
    expect(valid.ok).toBe(true);

    const applied = await kernel.services.promotions.applyPromotions({
      currency: "USD",
      subtotal: 2000,
      customerGroupIds: ["vip"],
      promotionCodes: ["SAVE10", "LESS200", "OLD"],
      lineItems: [{ entityId: product.id, entityType: "product", quantity: 2, unitPrice: 1000, totalPrice: 2000 }],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.totalDiscount).toBe(400);
    expect(applied.value.applied.map((item) => item.code)).toContain("SAVE10");
    expect(applied.value.applied.map((item) => item.code)).toContain("LESS200");
    expect(applied.value.rejectedCodes.some((item) => item.code === "OLD")).toBe(true);

    await kernel.services.promotions.recordUsage({
      promotions: [{ promotionId: tenOff.value.id, code: "SAVE10", type: "percentage_off_order", discountAmount: 200, freeShipping: false, description: "save" }],
      customerId: "00000000-0000-0000-0000-000000000001", // Valid UUID
      orderId: "00000000-0000-0000-0000-000000000099",
    });

    const limitReached = await kernel.services.promotions.validate("SAVE10", {
      currency: "USD",
      subtotal: 2000,
      customerId: "00000000-0000-0000-0000-000000000001", // Valid UUID
      customerGroupIds: ["vip"],
      lineItems: [{ entityId: product.id, entityType: "product", quantity: 2, unitPrice: 1000, totalPrice: 2000 }],
    });
    expect(limitReached.ok).toBe(false);
  });
});

describe("phase 3 shipping and checkout pipeline (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  // Declare arrays at describe scope so they can be shared
  let reportedTaxTransactions: string[] = [];
  let voidedTaxTransactions: string[] = [];

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig({
      payments: [mockPaymentAdapter],
      shipping: {
        type: "weight_based",
        flatRate: 500,
        freeShippingThreshold: 20000,
        brackets: [
          { upToGrams: 1000, cost: 300 },
          { upToGrams: 5000, cost: 700 },
        ],
        fallbackCost: 1200,
      },
      tax: {
        adapter: {
          providerId: "manual-test",
          async calculateTax(params) {
            const taxableAmount =
              params.lineItems.reduce(
                (sum, lineItem) => sum + lineItem.unitPrice * lineItem.quantity - (lineItem.discount ?? 0),
                0,
              ) + params.shippingAmount;
            return Ok({
              amountToCollect: Math.round(taxableAmount * 0.1),
              taxableAmount,
              rate: 0.1,
            });
          },
          async reportTransaction(params) {
            reportedTaxTransactions.push(params.transactionId);
            return Ok({ transactionId: params.transactionId });
          },
          async voidTransaction(params) {
            voidedTaxTransactions.push(params.transactionId);
            return Ok({ transactionId: params.transactionId });
          },
        },
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
    // Reset tax tracking arrays
    reportedTaxTransactions = [];
    voidedTaxTransactions = [];
  });

  it("calculates flat and weight shipping, tax and promotion through checkout hooks", async () => {

    const product = await createProduct(kernel, "checkout-phase3", { weightGrams: 400 });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 1000,
      minQuantity: 1,
      maxQuantity: 9,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 800,
      minQuantity: 10,
      maxQuantity: 49,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 700,
      customerGroupId: "wholesale",
      minQuantity: 1,
    });
    await kernel.services.pricing.setBasePrice({
      entityId: product.id,
      currency: "USD",
      amount: 1500,
      validUntil: new Date("2025-12-31T00:00:00.000Z"),
    });

    await kernel.services.promotions.create({
      code: "SAVE5",
      name: "Save 5",
      type: "percentage_off_order",
      value: 5,
    });

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      {
        entityId: product.id,
        adjustment: 100,
        reason: "stock",
      },
      actor as any,
    );

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor as any);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    await kernel.services.cart.addItem(
      {
        cartId: cart.value.id,
        entityId: product.id,
        quantity: 10,
      },
      actor as any,
    );

    const checkoutData: CheckoutData = {
      checkoutId: "co-phase3",
      cartId: cart.value.id,
      // customerId omitted for guest checkout
      customerGroupIds: ["wholesale"],
      currency: "USD",
      paymentMethodId: "test-payments",
      lineItems: [],
      subtotal: 0,
      discountTotal: 0,
      taxTotal: 0,
      shippingTotal: 0,
      total: 0,
      promotionCodes: ["SAVE5"],
      shippingAddress: {
        country: "US",
        postalCode: "90002",
        state: "CA",
        city: "Los Angeles",
      },
    };

    const processed = await runBeforeHooks(
      [
        validateCartNotEmpty,
        resolveCurrentPrices,
        checkInventoryAvailability,
        applyPromotionCodes,
        calculateTax,
        calculateShipping,
        validatePaymentMethod,
        authorizePayment,
      ],
      checkoutData,
      "create",
      {
        actor,
        tx: null,
        logger: kernel.logger,
        services: kernel.services as any,
        context: {},
        requestId: crypto.randomUUID(),
        origin: "rest" as const,
        jobs: { enqueue: async () => {} },
        kernel,
      } as any,
    );

    expect(processed.lineItems[0]?.resolvedUnitPrice).toBe(700);
    expect(processed.subtotal).toBe(7000);
    expect(processed.discountTotal).toBe(350);
    expect(processed.taxTotal).toBe(700);
    expect(processed.shippingTotal).toBe(700);
    expect(processed.total).toBe(8050);

    const orderInput = {
      // customerId omitted for guest checkout
      currency: processed.currency,
      subtotal: processed.subtotal,
      taxTotal: processed.taxTotal,
      shippingTotal: processed.shippingTotal,
      discountTotal: processed.discountTotal,
      grandTotal: processed.total,
      metadata: { checkoutId: processed.checkoutId },
      lineItems: processed.lineItems.map((lineItem) => ({
        entityId: lineItem.entityId,
        entityType: (lineItem.entityType ?? "product") as "product",
        title: lineItem.title ?? "item",
        quantity: lineItem.quantity,
        unitPrice: lineItem.resolvedUnitPrice ?? 0,
        totalPrice: lineItem.resolvedTotal ?? 0,
        ...(lineItem.variantId !== undefined ? { variantId: lineItem.variantId } : {}),
      })),
    };
    const order = await kernel.services.orders.create(orderInput, actor);

    expect(order.ok).toBe(true);
    if (!order.ok) return;

    await kernel.services.promotions.recordUsage({
      promotions: processed.appliedPromotions ?? [],
      orderId: order.value.id,
      ...(processed.customerId !== undefined ? { customerId: processed.customerId } : {}),
    });

    await kernel.services.tax.reportTransaction({
      transactionId: order.value.id,
      transactionDate: new Date(),
      currency: processed.currency,
      amount: processed.subtotal - processed.discountTotal + processed.shippingTotal,
      shipping: processed.shippingTotal,
      salesTax: processed.taxTotal,
      lineItems: processed.lineItems.map((lineItem, index) => ({
        id: lineItem.id ?? `${order.value.id}-${index + 1}`,
        entityId: lineItem.entityId,
        description: lineItem.title ?? lineItem.entityId,
        quantity: lineItem.quantity,
        unitPrice: lineItem.resolvedUnitPrice ?? 0,
      })),
      ...(processed.customerId !== undefined ? { customerId: processed.customerId } : {}),
      ...(processed.shippingAddress !== undefined ? { toAddress: processed.shippingAddress } : {}),
    });

    expect(reportedTaxTransactions).toContain(order.value.id);

    const cancelled = await kernel.services.orders.changeStatus(
      { orderId: order.value.id, newStatus: "cancelled", reason: "user_request" },
      actor as any,
    );
    expect(cancelled.ok).toBe(true);
    expect(voidedTaxTransactions).toContain(order.value.id);
  });
});
