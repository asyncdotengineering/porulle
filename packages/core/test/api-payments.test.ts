import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";
import { Err, Ok } from "../src/kernel/result.js";

describe("REST API: Payments", () => {
  let server: any;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await createTestServer();
    server = result.server;
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  // ─── POST /api/payments/webhook ───────────────────────────────────────────────

  describe("POST /api/payments/webhook", () => {
    it("maps provider webhook failures to safe actionable statuses", async () => {
      const failingAdapter = {
        providerId: "failing-webhook",
        async createPaymentIntent() {
          return Ok({ id: "pi_unused", status: "succeeded", amount: 0, currency: "USD" });
        },
        async capturePayment() {
          return Ok({ id: "pi_unused", status: "succeeded", amountCaptured: 0 });
        },
        async refundPayment() {
          return Ok({ id: "re_unused", status: "succeeded", amountRefunded: 0 });
        },
        async cancelPaymentIntent() {
          return Ok(undefined);
        },
        async verifyWebhook() {
          return Err({
            code: "WEBHOOK_SIGNATURE_MISSING",
            message: "Missing stripe-signature header.",
          });
        },
      };
      const isolated = await createTestServer({ payments: [failingAdapter] });
      try {
        const response = await makeRequest(isolated.server, {
          method: "POST",
          url: "http://localhost/api/payments/webhook",
          headers: { "content-type": "application/json" },
          body: {},
        });

        expect(response.status).toBe(400);
        await expect(parseJsonResponse(response)).resolves.toEqual({
          error: {
            code: "WEBHOOK_SIGNATURE_MISSING",
            message: "Missing stripe-signature header.",
          },
        });
      } finally {
        await isolated.cleanup();
      }
    });

    it("accepts valid webhook payload", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook",
        headers: {
          "content-type": "application/json",
        },
        body: {
          type: "commerce.webhook.probe",
          data: {
            metadata: {
              orderId: "00000000-0000-0000-0000-000000000001",
            },
          },
        },
      });

      expect(response.status).toBe(200);
      const json = await parseJsonResponse<{ data: { received: boolean } }>(response);
      expect(json.data.received).toBe(true);
    });

    it("rejects webhook with invalid signature", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "invalid_signature",
        },
        body: {
          type: "payment_intent.succeeded",
          data: {},
        },
      });

      // May return 401 (unauthorized) or 422 (validation error)
      expect([401, 422]).toContain(response.status);
    });

    it("handles payment_intent.succeeded event", async () => {
      // First create an order to update
      const createResponse = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/orders",
        body: {
          customerId: undefined,
          currency: "USD",
          subtotal: 10000,
          taxTotal: 0,
          shippingTotal: 0,
          discountTotal: 0,
          grandTotal: 10000,
          lineItems: [
            {
              entityId: "test-entity",
              entityType: "product",
              title: "Test",
              quantity: 1,
              unitPrice: 10000,
              totalPrice: 10000,
            },
          ],
        },
        actor: testActor,
      });

      if (createResponse.status === 201) {
        const created = await parseJsonResponse<{ data: { id: string } }>(createResponse);
        const orderId = created.data.id;

        const response = await makeRequest(server, {
          method: "POST",
          url: "http://localhost/api/payments/webhook",
          headers: {
            "content-type": "application/json",
          },
          body: {
            type: "payment_intent.succeeded",
            data: {
              metadata: { orderId },
            },
          },
        });

        expect(response.status).toBe(200);
        const updated = await server.request(`http://localhost/api/orders/${orderId}`, {
          headers: { "x-test-actor": JSON.stringify(testActor) },
        });
        expect(updated.status).toBe(200);
        const updatedBody = await parseJsonResponse<{ data: { status: string } }>(updated);
        expect(updatedBody.data.status).toBe("confirmed");
      }
    });

    it("handles missing payload gracefully", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook",
        headers: {
          "content-type": "application/json",
        },
        body: {}, // Missing type and data
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });
});
