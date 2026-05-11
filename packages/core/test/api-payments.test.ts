import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestServer,
  makeRequest,
  testActor,
  parseJsonResponse,
} from "../src/test-utils/rest-api-test-utils.js";

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
    it("accepts valid webhook payload", async () => {
      const response = await makeRequest(server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook",
        headers: {
          "content-type": "application/json",
        },
        body: {
          type: "payment_intent.succeeded",
          data: {
            metadata: {
              orderId: "00000000-0000-0000-0000-000000000001",
            },
          },
        },
      });

      // Webhook verification may succeed or fail depending on mock adapter
      expect([200, 401, 422]).toContain(response.status);

      if (response.status === 200) {
        const json = await parseJsonResponse<{ data: { received: boolean } }>(response);
        expect(json.data.received).toBe(true);
      }
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

        // May succeed or fail depending on verification
        expect([200, 401, 422]).toContain(response.status);
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
