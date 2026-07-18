import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEngineSetup, TaskDefinition } from "@porulle/core";

const { send, createFunction } = vi.hoisted(() => ({
  send: vi.fn(),
  createFunction: vi.fn((config, handler) => ({ config, handler })),
}));

vi.mock("inngest", () => ({
  Inngest: vi.fn(() => ({ send, createFunction })),
}));

import { InngestExecutionEngine } from "../src/index.js";

describe("InngestExecutionEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockResolvedValue({ ids: ["event-1"] });
  });

  it("translates task concurrency, supersession, retries, scheduling, and execution", async () => {
    const handled = vi.fn(async () => ({ output: { ok: true } }));
    const task: TaskDefinition = {
      slug: "catalog/import",
      concurrency: { key: (input) => String(input.storeId), supersedes: true },
      retries: { attempts: 4 },
      handler: handled,
    };
    const db = {} as ExecutionEngineSetup["context"]["db"];
    const engine = new InngestExecutionEngine();
    engine.register({
      tasks: new Map([[task.slug, task]]),
      context: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        db,
        services: {},
      },
    });

    expect(createFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `porulle:${task.slug}`,
        triggers: [{ event: `porulle/job/${task.slug}` }],
        retries: 3,
        concurrency: { limit: 1, key: "event.data.concurrencyKey" },
        debounce: { key: "event.data.concurrencyKey", period: "1s" },
      }),
      expect.any(Function),
    );

    await expect(
      engine.enqueue(
        task.slug,
        { storeId: "s1" },
        { organizationId: "org-1", delayMs: 500 },
      ),
    ).resolves.toBe("event-1");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `porulle/job/${task.slug}`,
        data: expect.objectContaining({ concurrencyKey: "s1", maxAttempts: 4 }),
        ts: expect.any(Number),
      }),
    );

    const handler = createFunction.mock.calls[0]![1];
    await expect(
      handler({
        event: {
          data: {
            input: { storeId: "s1" },
            organizationId: "org-1",
            maxAttempts: 4,
          },
        },
        attempt: 1,
      }),
    ).resolves.toEqual({ ok: true });
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({
        job: { attemptNumber: 2, maxAttempts: 4 },
      }),
    );

    await expect(
      engine.enqueue(
        task.slug,
        { storeId: "s1" },
        { organizationId: "org-1", maxAttempts: 2 },
      ),
    ).rejects.toThrow("retry counts are fixed");
  });
});
