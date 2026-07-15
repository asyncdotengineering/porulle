import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Ok } from "../src/kernel/result.js";
import { orders } from "../src/modules/orders/schema.js";
import { eq } from "drizzle-orm";
import { markOrderPaidForTest } from "../src/test-utils/order-test-helpers.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

// Recording payment adapter: captures every gateway refund amount so we can
// assert money-conservation (total refunded never exceeds captured).
let refundCalls: number[] = [];
const recordingPayments = {
  providerId: "rec",
  async createPaymentIntent(params: { amount: number; currency: string }) {
    return Ok({ id: `pi_${params.amount}`, status: "requires_capture", amount: params.amount, currency: params.currency, clientSecret: "x" });
  },
  async capturePayment(paymentIntentId: string, amount?: number) {
    return Ok({ id: paymentIntentId, status: "succeeded", ...(amount != null ? { amountCaptured: amount } : {}) });
  },
  async refundPayment(paymentId: string, amount: number) {
    refundCalls.push(amount);
    return Ok({ id: `re_${amount}`, status: "succeeded", amountRefunded: amount });
  },
  async cancelPaymentIntent() {
    return Ok(undefined);
  },
  async verifyWebhook() {
    return Ok({ id: "e", type: "t", data: {} });
  },
};

describe("VAPT: refund money-conservation", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let kernel: Awaited<ReturnType<typeof createTestServer>>["kernel"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const t = await createTestServer({ payments: [recordingPayments] as never });
    server = t.server;
    kernel = t.kernel;
    cleanup = t.cleanup;
  });
  afterAll(async () => {
    await cleanup();
  });
  beforeEach(() => {
    refundCalls = [];
  });

  // Create an order and (optionally) mark it captured.
  async function makeOrder(captured: boolean): Promise<{ orderId: string; lineItemId: string; total: number }> {
    const entRes = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `rmc-${crypto.randomUUID()}`, metadata: { title: "E" } },
      actor: testActor,
    });
    const entityId = (await parseJsonResponse<{ data: { id: string } }>(entRes)).data.id;
    const total = 5000;
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/orders",
      body: {
        currency: "USD", subtotal: total, taxTotal: 0, shippingTotal: 0, grandTotal: total,
        lineItems: [{ entityId, entityType: "product", title: "P", quantity: 1, unitPrice: total, totalPrice: total }],
      },
      actor: testActor,
    });
    const data = (await parseJsonResponse<{ data: { id: string; lineItems: Array<{ id: string }> } }>(res)).data;
    if (captured) {
      await markOrderPaidForTest(kernel, data.id, total, `pi_${data.id}`);
    }
    return { orderId: data.id, lineItemId: data.lineItems[0]!.id, total };
  }
  const refundLines = (orderId: string, lineItemId: string, quantity = 1) =>
    makeRequest(server, { method: "POST", url: `http://localhost/api/orders/${orderId}/refunds`, body: { lines: [{ lineItemId, quantity }] }, actor: testActor });

  it("R-01: order-level refund cannot double-pay on top of a line refund", async () => {
    const { orderId, lineItemId, total } = await makeOrder(true);
    const r1 = await refundLines(orderId, lineItemId);
    expect(r1.status).toBe(201);
    // Full order-level refund on top of the full line refund must not pay again.
    await makeRequest(server, { method: "PATCH", url: `http://localhost/api/orders/${orderId}/status`, body: { status: "refunded" }, actor: testActor });
    const totalRefunded = refundCalls.reduce((a, b) => a + b, 0);
    expect(totalRefunded).toBeLessThanOrEqual(total);
  });

  it("F-04: undoRefund → refundLines cannot re-issue a gateway refund", async () => {
    const { orderId, lineItemId, total } = await makeOrder(true);
    const r1 = await parseJsonResponse<{ data: { refund: { id: string } } }>(await refundLines(orderId, lineItemId));
    await makeRequest(server, { method: "POST", url: `http://localhost/api/orders/${orderId}/refunds/${r1.data.refund.id}/undo`, actor: testActor });
    await refundLines(orderId, lineItemId); // re-refund after undo
    const totalRefunded = refundCalls.reduce((a, b) => a + b, 0);
    expect(totalRefunded).toBeLessThanOrEqual(total); // gateway never paid twice
  });

  it("R-04: an order with a refunded line cannot be fulfilled", async () => {
    const { orderId, lineItemId } = await makeOrder(true);
    expect((await refundLines(orderId, lineItemId)).status).toBe(201);
    const res = await makeRequest(server, { method: "PATCH", url: `http://localhost/api/orders/${orderId}/status`, body: { status: "fulfilled" }, actor: testActor });
    expect(res.status).toBe(422);
  });

  it("R-03: refundLines on an uncaptured order is rejected", async () => {
    const { orderId, lineItemId } = await makeOrder(false);
    expect((await refundLines(orderId, lineItemId)).status).toBe(422);
  });

  it("R-02: refundLines on a terminal (cancelled) order is rejected", async () => {
    const { orderId, lineItemId } = await makeOrder(true);
    await makeRequest(server, { method: "PATCH", url: `http://localhost/api/orders/${orderId}/status`, body: { status: "cancelled" }, actor: testActor });
    expect((await refundLines(orderId, lineItemId)).status).toBe(422);
  });

  it("R-06: line items cannot be added to an order with an authorized payment", async () => {
    const { orderId } = await makeOrder(false);
    await kernel.database.db.update(orders).set({ paymentIntentId: `pi_auth_${orderId}` }).where(eq(orders.id, orderId));
    const entRes = await makeRequest(server, { method: "POST", url: "http://localhost/api/catalog/entities", body: { type: "product", slug: `rmc2-${crypto.randomUUID()}`, metadata: {} }, actor: testActor });
    const entityId = (await parseJsonResponse<{ data: { id: string } }>(entRes)).data.id;
    const res = await makeRequest(server, { method: "POST", url: `http://localhost/api/orders/${orderId}/line-items`, body: { entityId, entityType: "product", title: "X", quantity: 1, unitPrice: 100, totalPrice: 100 }, actor: testActor });
    expect(res.status).toBe(422);
  });
});
