import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { runAfterHooks, runBeforeHooks } from "../src/kernel/hooks/executor.js";
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

describe("cart + checkout + orders (PGlite-backed)", () => {
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

  it("runs checkout hook chain and creates orders with transitions", async () => {

    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "checkout-item",
        attributes: { title: "Checkout Item" },
        metadata: { basePrice: 2500 },
      },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      {
        entityId: entity.value.id,
        adjustment: 10,
        reason: "stock",
      },
      actor,
    );

    const cart = await kernel.services.cart.create({ currency: "USD" }, actor);
    expect(cart.ok).toBe(true);
    if (!cart.ok) return;

    const added = await kernel.services.cart.addItem(
      {
        cartId: cart.value.id,
        entityId: entity.value.id,
        quantity: 2,
      },
      actor,
    );
    expect(added.ok).toBe(true);

    const checkoutData: CheckoutData = {
      checkoutId: "co-1",
      cartId: cart.value.id,
      // customerId omitted for guest checkout
      currency: "USD",
      paymentMethodId: "test-payments",
      lineItems: [],
      subtotal: 0,
      discountTotal: 0,
      taxTotal: 0,
      shippingTotal: 0,
      total: 0,
    };

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

    const context = {
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

    const processed = await runBeforeHooks(beforeHooks as any, checkoutData, "create", context);

    const orderPayload = {
      currency: processed.currency,
      subtotal: processed.subtotal,
      taxTotal: processed.taxTotal,
      shippingTotal: processed.shippingTotal,
      discountTotal: processed.discountTotal,
      grandTotal: processed.total,
      metadata: { checkoutId: processed.checkoutId },
      lineItems: processed.lineItems.map((lineItem) => {
        const payload = {
          entityId: lineItem.entityId,
          entityType: "product",
          title: lineItem.title ?? "Item",
          quantity: lineItem.quantity,
          unitPrice: lineItem.resolvedUnitPrice ?? 0,
          totalPrice: lineItem.resolvedTotal ?? 0,
        };
        return lineItem.variantId !== undefined
          ? { ...payload, variantId: lineItem.variantId }
          : payload;
      }),
      ...(processed.customerId !== undefined ? { customerId: processed.customerId } : {}),
    };
    const order = await kernel.services.orders.create(orderPayload, actor);

    expect(order.ok).toBe(true);
    if (!order.ok) return;

    const afterReport = await runAfterHooks(
      [capturePayment, reserveInventory, initiateFulfillment, sendConfirmation, recordAnalyticsEvent],
      null,
      order.value,
      "create",
      context,
    );

    expect(afterReport.hasErrors).toBe(false);

    const transitioned = await kernel.services.orders.changeStatus(
      {
        orderId: order.value.id,
        newStatus: "confirmed",
      },
      actor,
    );

    expect(transitioned.ok).toBe(true);

    const history = await kernel.services.orders.getStatusHistory(order.value.id);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.length).toBeGreaterThanOrEqual(2);
  });
});
