import { describe, expect, it } from "vitest";
import { stripePayment } from "../src/index.js";

describe("stripe adapter", () => {
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
