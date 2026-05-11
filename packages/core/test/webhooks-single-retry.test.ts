import { describe, expect, it, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import { runPendingJobs } from "../src/kernel/jobs/runner.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";
import { webhookDeliveryTask } from "../src/modules/webhooks/tasks.js";
import { WebhooksRepository } from "../src/modules/webhooks/repository/index.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

describe("webhook job retries (single fetch per attempt)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("uses only job-level retries (4 fetches for 3 failures + success), backoff ≥ 1.5s, one delivery row per attempt", async () => {
    vi.useFakeTimers({ now: new Date("2025-01-01T00:00:00.000Z") });

    const fetchMock = vi.fn(async () => {
      const n = fetchMock.mock.calls.length;
      if (n <= 3) {
        return { ok: false, status: 500 };
      }
      return { ok: true, status: 200 };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { db } = await createPGliteTestAdapter();
    const repository = new WebhooksRepository(db as DrizzleDatabase);

    const endpoint = await repository.createEndpoint({
      organizationId: DEFAULT_ORG_ID,
      url: "https://example.com/webhook",
      secret: "secret",
      events: ["orders.create"],
      isActive: true,
    });

    const tasks = new Map<string, TaskDefinition>([
      [
        webhookDeliveryTask.slug,
        webhookDeliveryTask as TaskDefinition<
          Record<string, unknown>,
          Record<string, unknown>
        >,
      ],
    ]);
    const adapter = new DrizzleJobsAdapter(db as DrizzleDatabase, tasks);

    const jobId = await adapter.enqueue(
      "webhooks/deliver",
      {
        endpointId: endpoint.id,
        endpointUrl: "https://example.com/webhook",
        endpointSecret: "secret",
        eventName: "orders.create",
        payload: { id: "ord-1" },
      },
      { organizationId: DEFAULT_ORG_ID, maxAttempts: 5, queue: "default" },
    );

    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const services = {
      webhooks: { repository },
    };

    for (let round = 0; round < 12; round++) {
      await runPendingJobs({
        db: db as DrizzleDatabase,
        tasks,
        queue: "default",
        limit: 10,
        logger,
        services,
      });

      const rows = await db
        .select()
        .from(commerceJobs)
        .where(eq(commerceJobs.id, jobId));
      const job = rows[0]!;
      if (job.status === "succeeded") break;
      if (job.status === "failed") {
        throw new Error(`Job failed unexpectedly: ${job.error}`);
      }

      expect(job.status).toBe("pending");
      expect(job.waitUntil).not.toBeNull();
      const remainingMs = job.waitUntil!.getTime() - Date.now();
      expect(remainingMs).toBeGreaterThanOrEqual(1500);
      vi.advanceTimersByTime(remainingMs + 1);
    }

    expect(fetchMock).toHaveBeenCalledTimes(4);

    const deliveries = await repository.findDeliveriesByEndpointId(endpoint.id);
    expect(deliveries.length).toBe(4);

    const attemptCounts = deliveries.map((d) => d.attemptCount).sort((a, b) => a - b);
    expect(attemptCounts).toEqual([1, 2, 3, 4]);
  });
});
