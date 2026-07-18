import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEngineSetup, TaskDefinition } from "@porulle/core";

const { trigger, createTask } = vi.hoisted(() => ({
  trigger: vi.fn(),
  createTask: vi.fn((config) => ({ id: config.id, config })),
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: createTask,
  tasks: { trigger },
}));

import { TriggerExecutionEngine } from "../src/index.js";

describe("TriggerExecutionEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trigger.mockResolvedValue({ id: "run-1" });
  });

  it("translates queue concurrency, retries, debounce, delay, and execution", async () => {
    const handled = vi.fn(async () => ({ output: { ok: true } }));
    const definition: TaskDefinition = {
      slug: "catalog/import",
      concurrency: { key: (input) => String(input.storeId), supersedes: true },
      retries: { attempts: 4, backoff: { type: "fixed", delay: 2_000 } },
      handler: handled,
    };
    const db = {} as ExecutionEngineSetup["context"]["db"];
    const engine = new TriggerExecutionEngine({ queuePrefix: "test" });
    engine.register({
      tasks: new Map([[definition.slug, definition]]),
      context: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        db,
        services: {},
      },
    });

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: definition.slug,
        queue: { name: "test-catalog-import", concurrencyLimit: 1 },
        retry: {
          maxAttempts: 4,
          factor: 1,
          minTimeoutInMs: 2_000,
          maxTimeoutInMs: 2_000,
          randomize: false,
        },
      }),
    );

    await expect(
      engine.enqueue(
        definition.slug,
        { storeId: "s1" },
        { organizationId: "org-1", delayMs: 500 },
      ),
    ).resolves.toBe("run-1");
    expect(trigger).toHaveBeenCalledWith(
      definition.slug,
      expect.objectContaining({ concurrencyKey: "s1", maxAttempts: 4 }),
      expect.objectContaining({
        concurrencyKey: "s1",
        maxAttempts: 4,
        delay: expect.any(Date),
        debounce: { key: "s1", delay: "1s", mode: "trailing" },
      }),
    );

    const registered = createTask.mock.calls[0]![0];
    await expect(
      registered.run(
        { input: { storeId: "s1" }, organizationId: "org-1", maxAttempts: 4 },
        { ctx: { attempt: { number: 2 } } },
      ),
    ).resolves.toEqual({ ok: true });
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({
        job: { attemptNumber: 2, maxAttempts: 4 },
      }),
    );
  });
});
