import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { Ok } from "../src/kernel/result.js";

// Issue #37 — the REST API had no endpoints for refund, payment capture, or
// draft/manual order creation. These are now exposed and reach the payment
// adapter.
describe("Issue #37 — orders REST: draft create, capture, refund", () => {
  let server: any;
  let cleanup: () => Promise<void>;
  const refundCalls: Array<{ amount: number }> = [];
  const captureCalls: Array<{ amount: number | undefined }> = [];

  const spyPayments = {
    providerId: "spy-payments",
    async createPaymentIntent(p: { amount: number; currency: string }) {
      return Ok({ id: "pi_spy", status: "requires_capture", amount: p.amount, currency: p.currency, clientSecret: "s" });
    },
    async capturePayment(_id: string, amount?: number) {
      captureCalls.push({ amount });
      return Ok({ id: "pi_spy", status: "succeeded", amountCaptured: amount ?? 3200 });
    },
    async refundPayment(_id: string, amount: number) {
      refundCalls.push({ amount });
      return Ok({ id: "re_spy", status: "succeeded", amountRefunded: amount });
    },
    async cancelPaymentIntent() {
      return Ok(undefined);
    },
    async verifyWebhook() {
      return Ok({ id: "evt", type: "x", data: {} });
    },
  };

  beforeAll(async () => {
    const result = await createTestServer({ payments: [spyPayments] as never });
    server = result.server;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `order-${Date.now()}-${Math.round(performance.now())}`, metadata: { title: "O" } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  async function createDraftOrder(withPayment: boolean): Promise<{ status: number; data: any }> {
    const entityId = await createEntity();
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "USD",
        subtotal: 2500,
        taxTotal: 200,
        shippingTotal: 500,
        grandTotal: 3200,
        ...(withPayment ? { paymentIntentId: "pi_spy" } : {}),
        lineItems: [
          { entityId, entityType: "product", title: "Ceylon Black Tea", quantity: 2, unitPrice: 1250, totalPrice: 2500 },
        ],
      },
      actor: testActor,
    });
    const json = await parseJsonResponse<{ data: any }>(res);
    return { status: res.status, data: json.data };
  }

  async function setStatus(orderId: string, status: string) {
    return makeRequest(server, {
      method: "PATCH",
      url: `http://localhost/api/orders/${orderId}/status`,
      body: { status },
      actor: testActor,
    });
  }

  it("creates a draft/manual order via POST /api/orders", async () => {
    const { status, data } = await createDraftOrder(false);
    expect(status).toBe(201);
    expect(data.status).toBe("pending");
    expect(data.lineItems).toHaveLength(1);
    expect(data.grandTotal).toBe(3200);
  });

  it("captures an authorized payment via POST /api/orders/{id}/capture", async () => {
    const { data } = await createDraftOrder(true);
    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${data.id}/capture`,
      body: { amount: 2500 },
      actor: testActor,
    });
    expect(res.status).toBe(200);
    expect(captureCalls.some((c) => c.amount === 2500)).toBe(true);

    const get = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/orders/${data.id}`,
      actor: testActor,
    });
    const got = await parseJsonResponse<{ data: { amountCaptured: number } }>(get);
    expect(got.data.amountCaptured).toBe(2500);
  });

  it("refunds via POST /api/orders/{id}/refund, honoring the requested amount", async () => {
    const { data } = await createDraftOrder(true);
    // Drive to a refundable state: pending → confirmed → processing → fulfilled
    for (const s of ["confirmed", "processing", "fulfilled"]) {
      const r = await setStatus(data.id, s);
      expect(r.status).toBe(200);
    }

    const res = await makeRequest(server, {
      method: "POST",
      url: `http://localhost/api/orders/${data.id}/refund`,
      body: { amount: 500, reason: "partial return" },
      actor: testActor,
    });
    expect(res.status).toBe(200);
    const json = await parseJsonResponse<{ data: { status: string } }>(res);
    expect(json.data.status).toBe("refunded");
    expect(refundCalls.some((c) => c.amount === 500)).toBe(true);
  });
});
