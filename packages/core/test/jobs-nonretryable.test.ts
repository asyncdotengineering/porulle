import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { runPendingJobs } from "../src/kernel/jobs/runner.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import { TaskNonRetryableError } from "../src/kernel/jobs/types.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { eq } from "drizzle-orm";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("runPendingJobs non-retryable failures", () => {
  it("fails a job immediately on TaskNonRetryableError, ignoring remaining attempts", async () => {
    const { db } = await createPGliteTestAdapter();
    const attempts: number[] = [];
    const task: TaskDefinition = {
      slug: "test/non-retryable",
      retries: { attempts: 5 },
      handler: async ({ job }) => {
        attempts.push(job?.attemptNumber ?? 0);
        throw new TaskNonRetryableError("refused by upstream");
      },
    };
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);
    const jobId = await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });

    const result = await runPendingJobs({ db, tasks, logger, services: {} });
    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(attempts).toEqual([1]);

    const [row] = await db.select().from(commerceJobs).where(eq(commerceJobs.id, jobId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("refused by upstream");

    // A second cycle must find nothing to do — the job did not go back to pending.
    expect(await runPendingJobs({ db, tasks, logger, services: {} })).toEqual({
      processed: 0,
      failed: 0,
    });
    expect(attempts).toEqual([1]);
  });

  it("still retries a plain error up to maxAttempts", async () => {
    const { db } = await createPGliteTestAdapter();
    let calls = 0;
    const task: TaskDefinition = {
      slug: "test/retryable",
      retries: { attempts: 2 },
      handler: async () => {
        calls += 1;
        throw new Error("transient");
      },
    };
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);
    await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });

    expect(await runPendingJobs({ db, tasks, logger, services: {} })).toEqual({
      processed: 0,
      failed: 0,
    });
    expect(calls).toBe(1);

    // Force the retry to be due now instead of waiting on the backoff delay.
    await db.update(commerceJobs).set({ waitUntil: null });
    expect(await runPendingJobs({ db, tasks, logger, services: {} })).toEqual({
      processed: 0,
      failed: 1,
    });
    expect(calls).toBe(2);
  });

  it("fails immediately when a pass-through step opts into nonRetryable", async () => {
    const { db } = await createPGliteTestAdapter();
    let calls = 0;
    const task: TaskDefinition = {
      slug: "test/step-non-retryable",
      retries: { attempts: 3 },
      handler: async ({ ctx }) => {
        calls += 1;
        await ctx.step!.do(
          "charge",
          async () => {
            throw new Error("card declined");
          },
          { nonRetryable: true },
        );
        return { output: {} };
      },
    };
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);
    const jobId = await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });

    expect(await runPendingJobs({ db, tasks, logger, services: {} })).toEqual({
      processed: 0,
      failed: 1,
    });
    expect(calls).toBe(1);
    const [row] = await db.select().from(commerceJobs).where(eq(commerceJobs.id, jobId));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("card declined");
  });
});
