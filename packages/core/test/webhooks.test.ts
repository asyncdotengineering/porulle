import { describe, expect, it, vi } from "vitest";
import { WebhookDeliveryWorker } from "../src/modules/webhooks/worker.js";
import { WebhooksRepository } from "../src/modules/webhooks/repository/index.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";

describe("webhook worker", () => {
  it("performs one HTTP attempt per deliver call and throws on failure", async () => {
    const { db } = await createPGliteTestAdapter();
    const repository = new WebhooksRepository(db as DrizzleDatabase);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const worker = new WebhookDeliveryWorker({
      repository,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const endpoint = await repository.createEndpoint({
      organizationId: DEFAULT_ORG_ID,
      url: "https://example.com/webhook",
      secret: "secret",
      events: ["orders.create"],
      isActive: true,
    });

    await expect(
      worker.deliver({
        endpoint: {
          id: endpoint.id,
          url: "https://example.com/webhook",
          secret: "secret",
        },
        eventName: "orders.create",
        payload: { id: "ord-1" },
        jobAttempt: 1,
        jobMaxAttempts: 5,
        retryBackoff: { type: "exponential", delay: 2000 },
      }),
    ).rejects.toThrow(/Webhook delivery failed/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const deliveries = await repository.findDeliveriesByEndpointId(endpoint.id);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.attemptCount).toBe(1);
  });

  it("records success on first OK response", async () => {
    const { db } = await createPGliteTestAdapter();
    const repository = new WebhooksRepository(db as DrizzleDatabase);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const worker = new WebhookDeliveryWorker({
      repository,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const endpoint = await repository.createEndpoint({
      organizationId: DEFAULT_ORG_ID,
      url: "https://example.com/webhook",
      secret: "secret",
      events: ["orders.create"],
      isActive: true,
    });

    await worker.deliver({
      endpoint: {
        id: endpoint.id,
        url: "https://example.com/webhook",
        secret: "secret",
      },
      eventName: "orders.create",
      payload: { id: "ord-1" },
      jobAttempt: 2,
      jobMaxAttempts: 5,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const deliveries = await repository.findDeliveriesByEndpointId(endpoint.id);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0]!.attemptCount).toBe(2);
    expect(deliveries[0]!.deliveredAt).toBeDefined();
  });
});
