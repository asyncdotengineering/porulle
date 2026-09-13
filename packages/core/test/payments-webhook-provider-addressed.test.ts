import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { processedWebhookEvents } from "../src/modules/webhooks/schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import type { Kernel } from "../src/runtime/kernel.js";
import { Ok } from "../src/kernel/result.js";
import {
  createTestServer,
  makeRequest,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

/**
 * The payment webhook route must know WHICH gateway it is talking to.
 *
 * Before this suite, `POST /api/payments/webhook` resolved `config.payments[0]` — whichever adapter
 * happened to be registered first — verified the body with it, and then recorded the result in
 * `processed_webhook_events` under the hardcoded literal `provider: "stripe"`. An app whose only
 * adapter is not Stripe therefore had its notifications verified by its own adapter, filed under a
 * gateway it does not use, and answered 200. The answer being inert is not the problem: the ROW HAS
 * BEEN WRITTEN, and `event_id` is unique, so a delivery to that path consumes the id that the app's
 * own route was going to dedupe on.
 *
 * The route is now `POST /api/payments/webhook/:provider`. The rows below pin the three things that
 * follow from that, plus the one that keeps it from being undone.
 */

/** Minimal adapter whose webhook always verifies, reporting the event it was told to report. */
function fakeAdapter(providerId: string, event: { id: string; type: string; data?: unknown }) {
  return {
    providerId,
    async createPaymentIntent() {
      return Ok({ id: `pi_${providerId}`, status: "requires_action", amount: 0, currency: "USD" });
    },
    async capturePayment() {
      return Ok({ id: `pi_${providerId}`, status: "succeeded", amountCaptured: 0 });
    },
    async refundPayment() {
      return Ok({ id: `re_${providerId}`, status: "succeeded", amountRefunded: 0 });
    },
    async cancelPaymentIntent() {
      return Ok(undefined);
    },
    async verifyWebhook() {
      return Ok({ id: event.id, type: event.type, data: event.data ?? {} });
    },
  };
}

describe("payment webhooks are addressed by provider", () => {
  let kernel: Kernel;
  let cleanup: () => Promise<void>;

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it("T1 records the event under the resolved adapter's own providerId, not a literal", async () => {
    const isolated = await createTestServer({
      payments: [fakeAdapter("payhere", { id: "320027411", type: "payhere.payment.success" })],
    });
    try {
      const response = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook/payhere",
        headers: { "content-type": "application/json" },
        body: {},
      });
      expect(response.status).toBe(200);

      const db = isolated.kernel.database.db as DrizzleDatabase;
      const rows = await db
        .select()
        .from(processedWebhookEvents)
        .where(eq(processedWebhookEvents.eventId, "320027411"));

      expect(rows).toHaveLength(1);
      // The whole point. A literal "stripe" here is the defect.
      expect(rows[0]?.provider).toBe("payhere");
      expect(rows[0]?.eventType).toBe("payhere.payment.success");
    } finally {
      await isolated.cleanup();
    }
  });

  it("T2 resolves the adapter named in the path, not the first one registered", async () => {
    const isolated = await createTestServer({
      payments: [
        fakeAdapter("first-gateway", { id: "evt_from_first", type: "first.paid" }),
        fakeAdapter("second-gateway", { id: "evt_from_second", type: "second.paid" }),
      ],
    });
    try {
      const toSecond = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook/second-gateway",
        headers: { "content-type": "application/json" },
        body: {},
      });
      expect(toSecond.status).toBe(200);

      const toFirst = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook/first-gateway",
        headers: { "content-type": "application/json" },
        body: {},
      });
      expect(toFirst.status).toBe(200);

      const db = isolated.kernel.database.db as DrizzleDatabase;
      const rows = await db.select().from(processedWebhookEvents);
      const byProvider = new Map(rows.map((row) => [row.provider, row.eventId]));

      // Positional resolution makes BOTH rows come from the first adapter, so the
      // second-gateway delivery is filed with the first gateway's event id.
      expect(byProvider.get("second-gateway")).toBe("evt_from_second");
      expect(byProvider.get("first-gateway")).toBe("evt_from_first");
    } finally {
      await isolated.cleanup();
    }
  });

  it("T3 does not apply Stripe's event vocabulary to a foreign gateway's event", async () => {
    const server = await createTestServer();
    kernel = server.kernel;
    cleanup = server.cleanup;

    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `webhook-provider-${crypto.randomUUID()}`,
        status: "active",
        attributes: { title: "Webhook provider product" },
        metadata: {},
      },
      testActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) throw entity.error;
    const priced = await kernel.services.pricing.setBasePrice({
      entityId: entity.value.id,
      currency: "USD",
      amount: 5000,
    });
    expect(priced.ok).toBe(true);

    const order = await kernel.services.orders.create(
      {
        currency: "USD",
        subtotal: 5000,
        taxTotal: 0,
        shippingTotal: 0,
        discountTotal: 0,
        grandTotal: 5000,
        lineItems: [
          {
            entityId: entity.value.id,
            entityType: "product",
            title: "Webhook provider line",
            quantity: 1,
            unitPrice: 5000,
            totalPrice: 5000,
          },
        ],
      },
      testActor,
    );
    expect(order.ok).toBe(true);
    if (!order.ok) throw order.error;

    // A foreign gateway that happens to emit Stripe's event name and Stripe's metadata shape.
    // Under the old route this confirmed the order; under a provider-addressed one it must not,
    // because `payment_intent.succeeded` is Stripe's vocabulary and this is not Stripe.
    const isolated = await createTestServer({
      payments: [
        fakeAdapter("payhere", {
          id: "evt_foreign_lookalike",
          type: "payment_intent.succeeded",
          data: { metadata: { orderId: order.value.id } },
        }),
      ],
    });
    try {
      const response = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook/payhere",
        headers: { "content-type": "application/json" },
        body: {},
      });
      expect(response.status).toBe(200);
    } finally {
      await isolated.cleanup();
    }

    const after = await kernel.services.orders.getById(order.value.id, testActor);
    expect(after.ok).toBe(true);
    if (!after.ok) throw after.error;
    expect(after.value.status).toBe("pending");
  });

  it("T3b leaves no unaddressed webhook path and 404s an unregistered provider", async () => {
    const isolated = await createTestServer({
      payments: [fakeAdapter("payhere", { id: "evt_unused", type: "payhere.payment.success" })],
    });
    try {
      // The old surface must be GONE, not kept as an alias — an alias is the second code path
      // that this change exists to remove, and it would quietly keep the original defect alive.
      const unaddressed = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook",
        headers: { "content-type": "application/json" },
        body: {},
      });
      expect(unaddressed.status).toBe(404);

      const unknown = await makeRequest(isolated.server, {
        method: "POST",
        url: "http://localhost/api/payments/webhook/not-a-registered-gateway",
        headers: { "content-type": "application/json" },
        body: {},
      });
      expect(unknown.status).toBe(404);

      const db = isolated.kernel.database.db as DrizzleDatabase;
      const rows = await db.select().from(processedWebhookEvents);
      // Neither refused delivery may consume an event id.
      expect(rows).toHaveLength(0);
    } finally {
      await isolated.cleanup();
    }
  });
});
