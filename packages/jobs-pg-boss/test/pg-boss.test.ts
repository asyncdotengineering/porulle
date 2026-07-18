import { describe, expect, it, vi } from "vitest";
import type { ExecutionEngineSetup, TaskDefinition } from "@porulle/core";
import { PgBossExecutionEngine } from "../src/index.js";

function createClient() {
  let handler:
    | ((jobs: Array<Record<string, unknown>>) => Promise<unknown>)
    | undefined;
  return {
    client: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      createQueue: vi.fn(async () => undefined),
      send: vi.fn(async () => "sent-job"),
      upsert: vi.fn(async () => ({ jobs: ["upserted-job"] })),
      work: vi.fn(async (_name, _options, registeredHandler) => {
        handler = registeredHandler;
        return "worker-id";
      }),
    },
    run: async (job: Record<string, unknown>) => handler?.([job]),
  };
}

describe("PgBossExecutionEngine", () => {
  it("maps keyed supersession, retries, delay, and worker execution", async () => {
    const { client, run } = createClient();
    const handled = vi.fn(async () => ({ output: { ok: true } }));
    const task: TaskDefinition = {
      slug: "catalog/import",
      concurrency: {
        key: (input) => String(input.storeId),
        supersedes: true,
      },
      retries: {
        attempts: 4,
        backoff: { type: "exponential", delay: 2_000 },
      },
      handler: handled,
    };
    const db = {} as ExecutionEngineSetup["context"]["db"];
    const setup: ExecutionEngineSetup = {
      tasks: new Map([[task.slug, task]]),
      context: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        db,
        services: {},
      },
    };
    const engine = new PgBossExecutionEngine({ client, queuePrefix: "test" });
    engine.register(setup);

    await expect(
      engine.enqueue(
        task.slug,
        { storeId: "store-1" },
        { organizationId: "org-1", delayMs: 500 },
      ),
    ).resolves.toBe("upserted-job");

    expect(client.createQueue).toHaveBeenCalledWith("test-jobs", {
      policy: "singleton",
    });
    expect(client.upsert).toHaveBeenCalledWith(
      "test-jobs",
      expect.objectContaining({
        taskSlug: task.slug,
        queue: "default",
        concurrencyKey: "store-1",
      }),
      expect.objectContaining({
        singletonKey: "store-1",
        retryLimit: 3,
        retryDelay: 2,
        retryBackoff: true,
        startAfter: expect.any(Date),
      }),
    );

    await run({
      id: "job-1",
      retryCount: 1,
      retryLimit: 3,
      data: {
        taskSlug: task.slug,
        input: { storeId: "store-1" },
        organizationId: "org-1",
        maxAttempts: 4,
      },
    });
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { storeId: "store-1" },
        job: { attemptNumber: 2, maxAttempts: 4 },
      }),
    );
  });

  it("uses send for non-superseding jobs", async () => {
    const { client } = createClient();
    const task: TaskDefinition = {
      slug: "email/send",
      handler: async () => ({ output: {} }),
    };
    const engine = new PgBossExecutionEngine({ client });
    const db = {} as ExecutionEngineSetup["context"]["db"];
    engine.register({
      tasks: new Map([[task.slug, task]]),
      context: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        db,
        services: {},
      },
    });

    await expect(
      engine.enqueue(task.slug, {}, { organizationId: "org-1" }),
    ).resolves.toBe("sent-job");
    expect(client.send).toHaveBeenCalledWith(
      "porulle-jobs",
      expect.objectContaining({ taskSlug: task.slug }),
      expect.objectContaining({ id: expect.any(String), retryLimit: 0 }),
    );
  });
});
