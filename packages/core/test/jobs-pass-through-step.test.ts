import { describe, expect, it } from "vitest";
import { createPassThroughTaskStep } from "../src/kernel/jobs/step.js";
import { TaskNonRetryableError } from "../src/kernel/jobs/types.js";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { runPendingJobs } from "../src/kernel/jobs/runner.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

describe("createPassThroughTaskStep", () => {
  it("runs the step callback immediately and returns its result", async () => {
    const step = createPassThroughTaskStep();
    await expect(step.do("load", async () => "value")).resolves.toBe("value");
  });

  it("propagates a plain error unchanged", async () => {
    const step = createPassThroughTaskStep();
    await expect(step.do("load", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });

  it("wraps a plain error as TaskNonRetryableError when nonRetryable is requested", async () => {
    const step = createPassThroughTaskStep();
    await expect(
      step.do(
        "charge",
        async () => {
          throw new Error("refused");
        },
        { nonRetryable: true },
      ),
    ).rejects.toBeInstanceOf(TaskNonRetryableError);
  });

  it("does not double-wrap a TaskNonRetryableError already thrown by the callback", async () => {
    const step = createPassThroughTaskStep();
    const original = new TaskNonRetryableError("refused");
    await expect(
      step.do(
        "charge",
        async () => {
          throw original;
        },
        { nonRetryable: true },
      ),
    ).rejects.toBe(original);
  });

  it("sleep waits at least the requested duration", async () => {
    const step = createPassThroughTaskStep();
    const start = Date.now();
    await step.sleep("pause", 20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe("runPendingJobs threads a pass-through step into the handler", () => {
  it("lets a handler use ctx.step.do without a real durable engine", async () => {
    const { db } = await createPGliteTestAdapter();
    const task: TaskDefinition = {
      slug: "test/uses-step",
      handler: async ({ ctx }) => {
        const value = await ctx.step!.do("load", async () => "loaded");
        return { output: { value } };
      },
    };
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);
    await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });

    expect(await runPendingJobs({ db, tasks, logger: { info() {}, warn() {}, error() {} }, services: {} })).toEqual({
      processed: 1,
      failed: 0,
    });
  });
});
