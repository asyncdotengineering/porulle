import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    paymentIntents = {
      create: stripeMocks.createPaymentIntent,
      capture: vi.fn(),
      cancel: vi.fn(),
    };
    refunds = { create: vi.fn() };
    webhooks = { constructEvent: vi.fn() };
  },
}));

import { stripePayment } from "../src/index.js";

describe("stripe adapter", () => {
  beforeEach(() => {
    stripeMocks.createPaymentIntent.mockReset();
  });

  it("forwards a tokenized payment method and idempotency key for manual capture", async () => {
    stripeMocks.createPaymentIntent.mockResolvedValue({
      id: "pi_test_1",
      status: "requires_capture",
      amount: 4200,
      currency: "usd",
      client_secret: "pi_test_secret",
    });
    const adapter = stripePayment({ secretKey: "sk_test_123" });

    const result = await adapter.createPaymentIntent({
      amount: 4200,
      currency: "USD",
      orderId: "pending-order",
      paymentMethodToken: "pm_card_visa",
      idempotencyKey: "checkout_cart-v7",
    });

    expect(result.ok).toBe(true);
    expect(stripeMocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 4200,
        currency: "usd",
        capture_method: "manual",
        payment_method: "pm_card_visa",
        confirm: true,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      }),
      { idempotencyKey: "checkout_cart-v7" },
    );
  });

  it("returns error when webhook secret missing during verification", async () => {
    const adapter = stripePayment({
      secretKey: process.env.STRIPE_TEST_SECRET ?? "sk_test_123",
    });

    const result = await adapter.verifyWebhook(
      new Request("http://localhost/webhook", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );

    expect(result.ok).toBe(false);
  });
});
