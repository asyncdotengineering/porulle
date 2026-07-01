import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { Ok } from "../src/kernel/result.js";

// Ordereka field study: offline POS queues replay sales on reconnect, which
// double-charged without an idempotency primitive (ordereka hand-rolled
// metadata.idempotencyKey checks). Orders and checkout now accept an
// idempotencyKey — replays return the original order.
describe("order + checkout idempotencyKey (offline-retry safety)", () => {
  let server: any;
  let kernel: any;
  let cleanup: () => Promise<void>;
  const paymentIntentCalls: string[] = [];

  const spyPayments = {
    providerId: "spy-payments",
    async createPaymentIntent(p: { amount: number; currency: string }) {
      paymentIntentCalls.push(`${p.amount}`);
      return Ok({ id: `pi_${paymentIntentCalls.length}`, status: "succeeded", amount: p.amount, currency: p.currency, clientSecret: "s" });
    },
    async capturePayment() {
      return Ok({ id: "pi_spy", status: "succeeded", amountCaptured: 0 });
    },
    async refundPayment(_id: string, amount: number) {
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
    kernel = result.kernel;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntity(): Promise<string> {
    const res = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `idem-${Date.now()}-${Math.round(performance.now() * 1000)}`, metadata: { title: "I", basePrice: 2500 } },
      actor: testActor,
    });
    return (await parseJsonResponse<{ data: { id: string } }>(res)).data.id;
  }

  it("replays POST /api/orders with the same idempotencyKey instead of duplicating", async () => {
    const entityId = await createEntity();
    const key = `pos-sale-${Date.now()}`;
    const body = {
      idempotencyKey: key,
      currency: "USD",
      subtotal: 2500,
      taxTotal: 0,
      shippingTotal: 0,
      grandTotal: 2500,
      lineItems: [
        { entityId, entityType: "product", title: "Tee", quantity: 1, unitPrice: 2500, totalPrice: 2500 },
      ],
    };

    const first = await makeRequest(server, { method: "POST", url: "http://localhost/api/orders", body, actor: testActor });
    expect(first.status).toBe(201);
    const firstOrder = (await parseJsonResponse<{ data: any }>(first)).data;

    const second = await makeRequest(server, { method: "POST", url: "http://localhost/api/orders", body, actor: testActor });
    expect(second.status).toBe(201);
    const secondOrder = (await parseJsonResponse<{ data: any }>(second)).data;

    expect(secondOrder.id).toBe(firstOrder.id);
    expect(secondOrder.orderNumber).toBe(firstOrder.orderNumber);
  });

  it("replays POST /api/checkout with the same idempotencyKey without re-authorizing payment", async () => {
    const entityId = await createEntity();

    await kernel.services.inventory.createWarehouse({ name: "Main", code: `M${Date.now() % 100000}` });
    await kernel.services.inventory.adjust(
      { entityId, adjustment: 10, reason: "stock" },
      testActor,
    );

    const cart = await kernel.services.cart.create({ currency: "USD" }, testActor);
    expect(cart.ok).toBe(true);
    const added = await kernel.services.cart.addItem(
      { cartId: cart.value.id, entityId, quantity: 1 },
      testActor,
    );
    expect(added.ok).toBe(true);

    const key = `checkout-${Date.now()}`;
    const body = { cartId: cart.value.id, paymentMethodId: "spy-payments", currency: "USD", idempotencyKey: key };

    paymentIntentCalls.length = 0;
    const first = await makeRequest(server, { method: "POST", url: "http://localhost/api/checkout", body, actor: testActor });
    expect(first.status).toBe(201);
    const firstOrder = (await parseJsonResponse<{ data: any }>(first)).data;
    expect(paymentIntentCalls.length).toBe(1);

    const second = await makeRequest(server, { method: "POST", url: "http://localhost/api/checkout", body, actor: testActor });
    expect(second.status).toBe(201);
    const secondOrder = (await parseJsonResponse<{ data: any }>(second)).data;

    expect(secondOrder.id).toBe(firstOrder.id);
    // No second payment authorization happened on replay
    expect(paymentIntentCalls.length).toBe(1);
  });
});
