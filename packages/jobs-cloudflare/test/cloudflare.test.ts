import { describe, expect, it, vi } from "vitest";
import type { ExecutionEngineSetup, TaskDefinition } from "@porulle/core";
import {
  CloudflareExecutionEngine,
  type WorkflowBinding,
} from "../src/index.js";

describe("CloudflareExecutionEngine", () => {
  it("fails fast when native Workflows cannot enforce a keyed task", async () => {
    const task: TaskDefinition = {
      slug: "catalog/import",
      concurrency: { key: (input) => String(input.storeId) },
      handler: async () => ({ output: {} }),
    };
    const create = vi.fn<WorkflowBinding["create"]>();
    const engine = new CloudflareExecutionEngine({ workflow: { create } });
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
      engine.enqueue(task.slug, { storeId: "s1" }, { organizationId: "org-1" }),
    ).rejects.toThrow("no per-key queue concurrency primitive");
  });

  it("maps delay, retries, and keyed execution through a coordinator", async () => {
    const handled = vi.fn(async () => ({ output: { ok: true } }));
    const task: TaskDefinition = {
      slug: "catalog/import",
      concurrency: { key: (input) => String(input.storeId), supersedes: true },
      retries: { attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
      handler: handled,
    };
    const create = vi.fn<WorkflowBinding["create"]>(async () => ({
      id: "workflow-1",
    }));
    const coordinator = {
      enqueue: vi.fn(async (_payload, createInstance) => createInstance()),
      run: vi.fn(async (_key, handler) => handler()),
    };
    const engine = new CloudflareExecutionEngine({
      workflow: { create },
      coordinator,
    });
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
      engine.enqueue(
        task.slug,
        { storeId: "s1" },
        { organizationId: "org-1", delayMs: 500 },
      ),
    ).resolves.toBe("workflow-1");
    const payload = create.mock.calls[0]![0].params;
    const step = {
      sleep: vi.fn(async () => undefined),
      do: vi.fn(async (_name, _config, callback) => callback({ attempt: 2 })),
    };
    await expect(engine.run(payload, step)).resolves.toEqual({ ok: true });
    expect(step.sleep).toHaveBeenCalledWith("porulle-delay", 500);
    expect(step.do).toHaveBeenCalledWith(
      `porulle:${task.slug}`,
      { retries: { limit: 3, delay: 2_000, backoff: "exponential" } },
      expect.any(Function),
    );
    expect(coordinator.run).toHaveBeenCalledWith("s1", expect.any(Function));
    expect(handled).toHaveBeenCalledWith(
      expect.objectContaining({ job: { attemptNumber: 2, maxAttempts: 3 } }),
    );
  });
});
