import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { Ok } from "../src/kernel/result.js";

// Regression: a *full* capture (no amount in the request) must record the full
// authorized total, not 0. Adapters like the shipped dev Stripe mock echo back
// exactly the amount they are handed and default to 0 when the caller omits it
// (Stripe itself captures the full authorized amount for an omitted value, so
// the ambiguity only bites non-Stripe/mock adapters). The core must therefore
// pass the amount it intends to capture rather than relying on the adapter to
// infer it — see orders/service.ts capture() and hooks/checkout-completion.ts.
describe("order capture — full amount when no explicit amount is given", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let cleanup: () => Promise<void>;

  // Mirrors the dev mock / a naive custom adapter: captures exactly what it is
  // told and defaults to 0 when the caller omits the amount.
  const echoPayments = {
    providerId: "echo-payments",
    async createPaymentIntent(p: { amount: number; currency: string }) {
      return Ok({ id: "pi_echo", status: "requires_capture", amount: p.amount, currency: p.currency, clientSecret: "s" });
    },
    async capturePayment(_id: string, amount?: number) {
      return Ok({ id: "pi_echo", status: "succeeded", amountCaptured: amount ?? 0 });
    },
    async refundPayment(_id: string, amount: number) {
      return Ok({ id: "re_echo", status: "succeeded", amountRefunded: amount });
    },
    async cancelPaymentIntent() {
      return Ok(undefined);
    },
    async verifyWebhook() {
      return Ok({ id: "evt", type: "x", data: {} });
    },
  };

  beforeAll(async () => {
    const result = await createTestServer({ payments: [echoPayments] as never });
    server = result.server;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("records the full grandTotal, not 0, when capture is called with no amount", async () => {
    const entityRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `cap-${Date.now()}-${Math.round(performance.now())}`, metadata: { title: "C" } },
      actor: testActor,
    });
    const entityId = (await parseJsonResponse<{ data: { id: string } }>(entityRes)).data.id;

    const createRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "USD",
        subtotal: 2500,
        taxTotal: 200,
        shippingTotal: 500,
        grandTotal: 3200,
        paymentIntentId: "pi_echo",
        lineItems: [
          { entityId, entityType: "product", title: "X", quantity: 2, unitPrice: 1250, totalPrice: 2500 },
        ],
      },
      actor: testActor,
    });
    const order = (await parseJsonResponse<{ data: { id: string } }>(createRes)).data;

    // Full capture — no `amount` in the body (the admin "Capture payment" action).
    const cap = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${order.id}/capture`,
      body: {},
      actor: testActor,
    });
    expect(cap.status).toBe(200);

    const get = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${order.id}`,
      actor: testActor,
    });
    const got = (await parseJsonResponse<{ data: { amountCaptured: number } }>(get)).data;
    // Pre-fix this recorded 0 (the adapter's `amount ?? 0` swallowed by `??`).
    expect(got.amountCaptured).toBe(3200);
  });
});
