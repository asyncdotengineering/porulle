import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { computeOrderPricing } from "../src/modules/orders/quote.js";
import type { Actor } from "../src/auth/types.js";

// Staff actor (org resolves to the default org, like the phase-3 harness).
const actor: Actor = {
  type: "user",
  userId: "staff-1",
  email: "staff@example.com",
  name: "Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "orders:create",
    "orders:read",
    "orders:manage",
    "pricing:manage",
    "promotions:manage",
    "tax:manage",
  ],
};

describe("computeOrderPricing (order quote engine)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;
  let entityId: string;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);

    const product = await kernel.services.catalog.create(
      { type: "product", slug: "quote-widget", attributes: { title: "Quote Widget" } },
      actor as never,
    );
    if (!product.ok) throw product.error;
    entityId = product.value.id;
    await kernel.services.catalog.publish(entityId, actor as never);

    // Price 5000 (minor units).
    const price = await kernel.services.pricing.setBasePrice({
      entityId,
      currency: "USD",
      amount: 5000,
    });
    if (!price.ok) throw price.error;

    // 20%-off-order promotion.
    const promo = await kernel.services.promotions.create(
      { code: "SAVE20", name: "Save 20", type: "percentage_off_order", value: 20 },
      actor as never,
    );
    if (!promo.ok) throw promo.error;

    // Runtime US tax rate 10%, appliesToShipping (default true).
    const rate = await kernel.services.tax.createTaxRate(
      { name: "US Sales Tax", country: "US", rateBps: 1000, appliesToShipping: true },
      actor,
    );
    if (!rate.ok) throw rate.error;
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("computes discount, then shipping, then tax on the discounted base + shipping", async () => {
    const q = await computeOrderPricing(
      kernel,
      {
        currency: "USD",
        lineItems: [{ entityId, entityType: "product", quantity: 1 }],
        promotionCodes: ["SAVE20"],
        shippingAddress: { line1: "1 St", city: "Los Angeles", state: "CA", postalCode: "90002", country: "US" },
      },
      actor,
    );

    expect(q.subtotal).toBe(5000);
    // 20% off the order.
    expect(q.discountTotal).toBe(1000);

    const discountedSubtotal = q.subtotal - q.discountTotal; // 4000
    // C1 + C2a: tax is 10% of (discounted subtotal + shipping) — shipping ran
    // before tax (so appliesToShipping fires) AND the discount reduced the base.
    const expectedTax = Math.round(((discountedSubtotal + q.shippingTotal) * 1000) / 10_000);
    expect(q.taxTotal).toBe(expectedTax);
    // Guard against the C2a regression: tax must NOT be 10% of the pre-discount subtotal.
    expect(q.taxTotal).not.toBe(Math.round((q.subtotal * 1000) / 10_000));

    // grandTotal cross-foots.
    expect(q.grandTotal).toBe(
      q.subtotal - q.discountTotal + q.shippingTotal + q.taxTotal,
    );
  }, 30_000);

  it("returns a bare subtotal for a no-promo, no-address quote", async () => {
    const q = await computeOrderPricing(
      kernel,
      { currency: "USD", lineItems: [{ entityId, entityType: "product", quantity: 3 }] },
      actor,
    );
    expect(q.subtotal).toBe(15000);
    expect(q.discountTotal).toBe(0);
    expect(q.grandTotal).toBe(
      q.subtotal - q.discountTotal + q.shippingTotal + q.taxTotal,
    );
  }, 30_000);
});
