import { describe, expect, it } from "vitest";
import { taxjarAdapter } from "../src/index.js";

describe("taxjar adapter", () => {
  it("maps calculate/report/void API calls", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];

    const adapter = taxjarAdapter({
      apiKey: "test_key",
      apiBaseUrl: "https://api.sandbox.taxjar.com/v2",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const rawBody = init?.body;
        requests.push({
          url,
          method,
          body: typeof rawBody === "string" ? JSON.parse(rawBody) : undefined,
        });

        if (url.endsWith("/taxes") && method === "POST") {
          return new Response(
            JSON.stringify({ tax: { amount_to_collect: 87.5, taxable_amount: 875, rate: 0.1 } }),
            { status: 200 },
          );
        }

        if (url.endsWith("/transactions/order") && method === "POST") {
          return new Response(JSON.stringify({ transaction: { transaction_id: "tx-1" } }), { status: 200 });
        }

        if (url.endsWith("/transactions/orders/tx-1") && method === "DELETE") {
          return new Response(null, { status: 200 });
        }

        return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
      },
    });

    const calculated = await adapter.calculateTax({
      currency: "USD",
      shippingAmount: 75,
      toAddress: { country: "US", postalCode: "90002", state: "CA", city: "Los Angeles", line1: "1 Main" },
      lineItems: [{ id: "1", entityId: "e1", description: "item", quantity: 1, unitPrice: 800 }],
    });
    expect(calculated.ok).toBe(true);
    if (!calculated.ok) return;
    expect(calculated.value.amountToCollect).toBe(88);

    const reported = await adapter.reportTransaction({
      transactionId: "tx-1",
      transactionDate: new Date("2026-03-08T00:00:00.000Z"),
      currency: "USD",
      amount: 875,
      shipping: 75,
      salesTax: 88,
      lineItems: [{ id: "1", entityId: "e1", description: "item", quantity: 1, unitPrice: 800 }],
      toAddress: { country: "US", postalCode: "90002", state: "CA", city: "Los Angeles", line1: "1 Main" },
    });
    expect(reported.ok).toBe(true);

    const voided = await adapter.voidTransaction({ transactionId: "tx-1" });
    expect(voided.ok).toBe(true);

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "POST https://api.sandbox.taxjar.com/v2/taxes",
      "POST https://api.sandbox.taxjar.com/v2/transactions/order",
      "DELETE https://api.sandbox.taxjar.com/v2/transactions/orders/tx-1",
    ]);
  });

  it("can run against TaxJar sandbox when TAXJAR_SANDBOX_KEY is set", async () => {
    const apiKey = process.env.TAXJAR_SANDBOX_KEY;
    if (!apiKey) {
      expect(true).toBe(true);
      return;
    }

    const adapter = taxjarAdapter({ apiKey, apiBaseUrl: "https://api.sandbox.taxjar.com/v2" });
    const result = await adapter.calculateTax({
      currency: "USD",
      shippingAmount: 10,
      toAddress: { country: "US", postalCode: "90002", state: "CA" },
      lineItems: [{ id: "1", entityId: "e1", description: "item", quantity: 1, unitPrice: 100 }],
    });

    expect(result.ok).toBe(true);
  });
});
