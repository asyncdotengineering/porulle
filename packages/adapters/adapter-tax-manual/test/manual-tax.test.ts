import { describe, expect, it } from "vitest";
import { manualTaxAdapter } from "../src/index.js";

describe("manual tax adapter", () => {
  it("calculates tax and supports report/void", async () => {
    const adapter = manualTaxAdapter({ rate: 0.1, shippingTaxable: true });

    const calculated = await adapter.calculateTax({
      currency: "USD",
      shippingAmount: 500,
      lineItems: [
        { id: "1", entityId: "e1", description: "item", quantity: 2, unitPrice: 1000, discount: 100 },
      ],
    });

    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;

    expect(calculated.value.taxableAmount).toBe(2400);
    expect(calculated.value.amountToCollect).toBe(240);

    const reported = await adapter.reportTransaction({
      transactionId: "tx-1",
      transactionDate: new Date("2026-03-08T00:00:00.000Z"),
      currency: "USD",
      amount: 2400,
      shipping: 500,
      salesTax: 240,
      lineItems: [{ id: "1", entityId: "e1", description: "item", quantity: 2, unitPrice: 1000 }],
    });
    expect(reported.ok).toBe(true);

    const voided = await adapter.voidTransaction({ transactionId: "tx-1" });
    expect(voided.ok).toBe(true);
  });
});
