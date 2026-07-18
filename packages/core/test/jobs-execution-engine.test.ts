import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionEngine,
  ExecutionEngineSetup,
  TaskDefinition,
} from "../src/index.js";
import { BUILTIN_JOB_TASK_SLUGS } from "../src/kernel/jobs/types.js";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

describe("job execution engine selection", () => {
  it("registers and runs the configured engine instead of the Drizzle default", async () => {
    const register = vi.fn<(setup: ExecutionEngineSetup) => void>();
    const run = vi.fn(async () => ({ processed: 7, failed: 1 }));
    const engine: ExecutionEngine = {
      execution: { mode: "pull", run },
      register,
      async enqueue() {
        return "external-job";
      },
    };
    const task: TaskDefinition = {
      slug: "test/custom-engine",
      handler: async () => ({ output: {} }),
    };
    const processingOrder = { field: "createdAt", direction: "desc" } as const;
    const server = await createServer(
      await createTestConfig({
        jobs: { adapter: engine, tasks: [task], processingOrder },
      }),
    );

    expect((server.kernel.services as Record<string, unknown>).jobs).toBe(
      engine,
    );
    expect(register).toHaveBeenCalledOnce();
    const setup = register.mock.calls[0]![0];
    expect(setup.tasks.get(task.slug)).toBe(task);
    expect(setup.tasks.has(BUILTIN_JOB_TASK_SLUGS.webhookDeliver)).toBe(true);
    expect(setup.processingOrder).toEqual(processingOrder);

    await expect(server.runJobs("priority", 3)).resolves.toEqual({
      processed: 7,
      failed: 1,
    });
    expect(run).toHaveBeenCalledWith({ queue: "priority", limit: 3 });
  });
});
