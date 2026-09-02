import { describe, expect, it, vi } from "vitest";
import type { ExecutionEngineSetup, TaskDefinition } from "@porulle/core";
import { TaskNonRetryableError } from "@porulle/core";
import {
  CloudflareExecutionEngine,
  adaptWorkflowBinding,
  type RawWorkflowBinding,
  type WorkflowBinding,
  type WorkflowStep,
} from "../src/index.js";

/** Stands in for `NonRetryableError` from `cloudflare:workflows`. */
class FakeNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

function createSetupContext(): ExecutionEngineSetup["context"] {
  const db = {} as ExecutionEngineSetup["context"]["db"];
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    db,
    services: {},
  };
}

/** Behaves like Workflows: retries the callback `retries.limit` times unless it
 * throws the non-retryable class, which ends the step at once. */
function createStepMock(): WorkflowStep {
  const step: WorkflowStep = {
    async sleep() {},
    async do(_name, config, callback) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await callback({ attempt });
        } catch (error) {
          if (
            error instanceof FakeNonRetryableError ||
            attempt > config.retries.limit
          ) {
            throw error;
          }
        }
      }
    },
    async waitForEvent() {},
  };
  vi.spyOn(step, "sleep");
  vi.spyOn(step, "do");
  vi.spyOn(step, "waitForEvent");
  return step;
}

function createWorkflowMock(createId = "workflow-1") {
  return {
    create: vi.fn<WorkflowBinding["create"]>(async () => ({ id: createId })),
    get: vi.fn<WorkflowBinding["get"]>(),
  };
}

function createEngine(
  task: TaskDefinition,
  extra: Partial<ConstructorParameters<typeof CloudflareExecutionEngine>[0]> = {},
) {
  const workflow = createWorkflowMock();
  const engine = new CloudflareExecutionEngine({
    workflow,
    nonRetryableError: FakeNonRetryableError,
    ...extra,
  });
  engine.register({
    tasks: new Map([[task.slug, task]]),
    context: createSetupContext(),
  });
  return { workflow, engine };
}

async function enqueued(
  engine: CloudflareExecutionEngine,
  workflow: ReturnType<typeof createWorkflowMock>,
  task: TaskDefinition,
  input: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
) {
  await engine.enqueue(task.slug, input, { organizationId: "org-1", ...options });
  return workflow.create.mock.calls[0]![0].params;
}

describe("CloudflareExecutionEngine", () => {
  it("fails fast when native Workflows cannot enforce a keyed task", async () => {
    const task: TaskDefinition = {
      slug: "catalog/import",
      concurrency: { key: (input) => String(input.storeId) },
      handler: async () => ({ output: {} }),
    };
    const { engine } = createEngine(task);

    await expect(
      engine.enqueue(task.slug, { storeId: "s1" }, { organizationId: "org-1" }),
    ).rejects.toThrow("no per-key queue concurrency primitive");
  });

  it("uses a caller-supplied jobId as the Workflow instance id and threads it through the payload", async () => {
    const task: TaskDefinition = {
      slug: "catalog/import",
      handler: async () => ({ output: {} }),
    };
    const workflow = createWorkflowMock("caller-id");
    const engine = new CloudflareExecutionEngine({
      workflow,
      nonRetryableError: FakeNonRetryableError,
    });
    engine.register({
      tasks: new Map([[task.slug, task]]),
      context: createSetupContext(),
    });

    await expect(
      engine.enqueue(task.slug, {}, { organizationId: "org-1", jobId: "caller-id" }),
    ).resolves.toBe("caller-id");
    expect(workflow.create).toHaveBeenCalledWith({
      id: "caller-id",
      params: expect.objectContaining({ jobId: "caller-id" }),
    });
  });

  it("retries a plain handler as one step with the task's attempts and honors the enqueue delay", async () => {
    const attempts: number[] = [];
    const task: TaskDefinition = {
      slug: "catalog/import",
      retries: { attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
      handler: async ({ job }) => {
        attempts.push(job!.attemptNumber);
        if (attempts.length < 3) throw new Error("transient");
        return { output: { ok: true } };
      },
    };
    const { engine, workflow } = createEngine(task);
    const payload = await enqueued(engine, workflow, task, {}, { delayMs: 500 });
    const step = createStepMock();

    await expect(engine.run(payload, step)).resolves.toEqual({ ok: true });
    expect(step.sleep).toHaveBeenCalledWith("porulle-delay", 500);
    expect(step.do).toHaveBeenCalledWith(
      `porulle:${task.slug}`,
      { retries: { limit: 2, delay: 2_000, backoff: "exponential" } },
      expect.any(Function),
    );
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("stops retrying a plain handler that throws TaskNonRetryableError", async () => {
    const handled = vi.fn(async () => {
      throw new TaskNonRetryableError("refused");
    });
    const task: TaskDefinition = {
      slug: "catalog/import",
      retries: { attempts: 3 },
      handler: handled,
    };
    const { engine, workflow } = createEngine(task);
    const payload = await enqueued(engine, workflow, task);

    await expect(engine.run(payload, createStepMock())).rejects.toBeInstanceOf(
      FakeNonRetryableError,
    );
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("gives a plain handler a pass-through ctx.step instead of nesting Workflow steps", async () => {
    const task: TaskDefinition = {
      slug: "catalog/import",
      handler: async ({ ctx }) => {
        const value = await ctx.step!.do("load", async () => "loaded");
        return { output: { value } };
      },
    };
    const { engine, workflow } = createEngine(task);
    const payload = await enqueued(engine, workflow, task);
    const step = createStepMock();

    await expect(engine.run(payload, step)).resolves.toEqual({ value: "loaded" });
    expect(step.do).toHaveBeenCalledTimes(1);
    expect(step.do).toHaveBeenCalledWith(
      `porulle:${task.slug}`,
      expect.anything(),
      expect.any(Function),
    );
  });

  it("runs a durableSteps handler in the body and forwards ctx.step.do as top-level steps with the task's retry config", async () => {
    const task: TaskDefinition = {
      slug: "catalog/import",
      retries: { attempts: 5, backoff: { type: "exponential", delay: 3_000 } },
      durableSteps: true,
      handler: async ({ ctx }) => {
        const value = await ctx.step!.do("load", async () => "loaded");
        return { output: { value } };
      },
    };
    const { engine, workflow } = createEngine(task);
    const payload = await enqueued(engine, workflow, task);
    const step = createStepMock();

    await expect(engine.run(payload, step)).resolves.toEqual({ value: "loaded" });
    expect(step.do).toHaveBeenCalledTimes(1);
    expect(step.do).toHaveBeenCalledWith(
      `porulle:${task.slug}:load`,
      { retries: { limit: 4, delay: 3_000, backoff: "exponential" } },
      expect.any(Function),
    );
  });

  it("maps a TaskNonRetryableError thrown inside a step to NonRetryableError before the step can retry", async () => {
    let calls = 0;
    const task: TaskDefinition = {
      slug: "catalog/import",
      retries: { attempts: 4 },
      durableSteps: true,
      handler: async ({ ctx }) => {
        await ctx.step!.do("charge", async () => {
          calls += 1;
          throw new TaskNonRetryableError("refused");
        });
        return { output: {} };
      },
    };
    const { engine, workflow } = createEngine(task);
    const payload = await enqueued(engine, workflow, task);

    await expect(engine.run(payload, createStepMock())).rejects.toMatchObject({
      name: "NonRetryableError",
      message: "refused",
    });
    expect(calls).toBe(1);
  });

  it("forces a zero-retry step and a NonRetryableError when a step call opts into nonRetryable", async () => {
    let calls = 0;
    const task: TaskDefinition = {
      slug: "catalog/import",
      retries: { attempts: 4 },
      durableSteps: true,
      handler: async ({ ctx }) => {
        await ctx.step!.do(
          "charge",
          async () => {
            calls += 1;
            throw new Error("boom");
          },
          { nonRetryable: true },
        );
        return { output: {} };
      },
    };
    const { engine, workflow } = createEngine(task);
    const payload = await enqueued(engine, workflow, task);
    const step = createStepMock();

    await expect(engine.run(payload, step)).rejects.toBeInstanceOf(FakeNonRetryableError);
    expect(calls).toBe(1);
    expect(step.do).toHaveBeenCalledWith(
      `porulle:${task.slug}:charge`,
      { retries: { limit: 0, delay: 1_000, backoff: "constant" } },
      expect.any(Function),
    );
  });

  it("runs an exclusive keyed task through the coordinator", async () => {
    const handled = vi.fn(async () => ({ output: { ok: true } }));
    const task: TaskDefinition = {
      slug: "catalog/import",
      concurrency: { key: (input) => String(input.storeId), supersedes: true },
      handler: handled,
    };
    const coordinator = {
      enqueue: vi.fn(async (_payload, createInstance) => createInstance()),
      run: vi.fn(async (_payload, _step, handler) => handler()),
    };
    const { engine, workflow } = createEngine(task, { coordinator });
    const payload = await enqueued(engine, workflow, task, { storeId: "s1" });
    const step = createStepMock();

    await expect(engine.run(payload, step)).resolves.toEqual({ ok: true });
    expect(coordinator.run).toHaveBeenCalledWith(payload, step, expect.any(Function));
  });

  it("reads instance status and terminates on cancel through the Workflow binding", async () => {
    const handle = {
      status: vi.fn(async () => ({ status: "running" as const })),
      terminate: vi.fn(async () => undefined),
      sendEvent: vi.fn(async () => undefined),
    };
    const workflow: WorkflowBinding = {
      create: vi.fn(),
      get: vi.fn(async () => handle),
    };
    const engine = new CloudflareExecutionEngine({
      workflow,
      nonRetryableError: FakeNonRetryableError,
    });

    await expect(engine.status("job-1")).resolves.toEqual({ status: "running" });
    expect(workflow.get).toHaveBeenCalledWith("job-1");

    await engine.cancel("job-1");
    expect(handle.terminate).toHaveBeenCalledOnce();
  });

  it("folds Cloudflare's instance status and error onto JobInstanceStatus", async () => {
    const statuses: Array<[string, string]> = [
      ["queued", "queued"],
      ["running", "running"],
      ["paused", "waiting"],
      ["waitingForPause", "waiting"],
      ["waiting", "waiting"],
      ["complete", "complete"],
      ["errored", "errored"],
      ["terminated", "terminated"],
      ["unknown", "errored"],
    ];
    for (const [raw, expected] of statuses) {
      const binding: RawWorkflowBinding = {
        create: async () => ({ id: "x" }),
        get: async () => ({
          status: async () => ({ status: raw, error: { name: "Error", message: "boom" } }),
          terminate: async () => undefined,
          sendEvent: async () => undefined,
        }),
      };
      const handle = await adaptWorkflowBinding(binding).get("x");
      await expect(handle.status()).resolves.toEqual({ status: expected, error: "boom" });
    }
  });

  it("does not register a keyed task that is neither exclusive nor superseding with the coordinator", async () => {
    const task: TaskDefinition = {
      slug: "catalog/import",
      concurrency: { key: (input) => String(input.storeId), exclusive: false },
      handler: async () => ({ output: {} }),
    };
    const coordinator = {
      enqueue: vi.fn(async (_payload, createInstance) => createInstance()),
      run: vi.fn(async (_payload, _step, handler) => handler()),
    };
    const { engine, workflow } = createEngine(task, { coordinator });

    await engine.enqueue(task.slug, { storeId: "s1" }, { organizationId: "org-1" });
    expect(coordinator.enqueue).not.toHaveBeenCalled();
    expect(workflow.create).toHaveBeenCalledOnce();
  });
});
