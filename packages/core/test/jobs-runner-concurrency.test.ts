import { asc, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { runPendingJobs } from "../src/kernel/jobs/runner.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function exclusiveTask(handler: TaskDefinition["handler"]): TaskDefinition {
  return {
    slug: "test/exclusive",
    concurrency: {
      key: (input) => String(input.key),
    },
    handler,
  };
}

describe("runPendingJobs concurrency", () => {
  it("runs one same-key job per cycle and releases the other", async () => {
    const { db } = await createPGliteTestAdapter();
    const handled: string[] = [];
    const task = exclusiveTask(async ({ input }) => {
      handled.push(String(input.id));
      return { output: {} };
    });
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);

    await jobs.enqueue(
      task.slug,
      { id: "first", key: "store-1" },
      { organizationId: DEFAULT_ORG_ID },
    );
    await jobs.enqueue(
      task.slug,
      { id: "second", key: "store-1" },
      { organizationId: DEFAULT_ORG_ID },
    );

    const firstCycle = await runPendingJobs({
      db,
      tasks,
      logger,
      services: {},
    });
    const afterFirstCycle = await db
      .select()
      .from(commerceJobs)
      .orderBy(asc(commerceJobs.createdAt));

    expect(firstCycle).toEqual({ processed: 1, failed: 0 });
    expect(handled).toEqual(["first"]);
    expect(afterFirstCycle.map((job) => job.status)).toEqual([
      "succeeded",
      "pending",
    ]);
    expect(afterFirstCycle[1]?.processingStartedAt).toBeNull();

    const secondCycle = await runPendingJobs({
      db,
      tasks,
      logger,
      services: {},
    });

    expect(secondCycle).toEqual({ processed: 1, failed: 0 });
    expect(handled).toEqual(["first", "second"]);
  });

  it("runs different concurrency keys in parallel", async () => {
    const { db } = await createPGliteTestAdapter();
    let active = 0;
    let maxActive = 0;
    const task = exclusiveTask(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { output: {} };
    });
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);

    await jobs.enqueue(
      task.slug,
      { key: "store-1" },
      { organizationId: DEFAULT_ORG_ID },
    );
    await jobs.enqueue(
      task.slug,
      { key: "store-2" },
      { organizationId: DEFAULT_ORG_ID },
    );

    expect(await runPendingJobs({ db, tasks, logger, services: {} })).toEqual({
      processed: 2,
      failed: 0,
    });
    expect(maxActive).toBe(2);
  });

  it("allows same-key jobs to overlap when exclusivity is disabled", async () => {
    const { db } = await createPGliteTestAdapter();
    let active = 0;
    let maxActive = 0;
    const task: TaskDefinition = {
      slug: "test/non-exclusive",
      concurrency: {
        key: (input) => String(input.key),
        exclusive: false,
      },
      handler: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { output: {} };
      },
    };
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);

    await jobs.enqueue(
      task.slug,
      { key: "store-1" },
      { organizationId: DEFAULT_ORG_ID },
    );
    await jobs.enqueue(
      task.slug,
      { key: "store-1" },
      { organizationId: DEFAULT_ORG_ID },
    );

    expect(await runPendingJobs({ db, tasks, logger, services: {} })).toEqual({
      processed: 2,
      failed: 0,
    });
    expect(maxActive).toBe(2);
  });

  it("honors a custom processing-order comparator", async () => {
    const { db } = await createPGliteTestAdapter();
    const handled: string[] = [];
    const task: TaskDefinition = {
      slug: "test/ordered",
      handler: async ({ input }) => {
        handled.push(String(input.id));
        return { output: {} };
      },
    };
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);

    await jobs.enqueue(
      task.slug,
      { id: "low", priority: 1 },
      { organizationId: DEFAULT_ORG_ID },
    );
    await jobs.enqueue(
      task.slug,
      { id: "high", priority: 10 },
      { organizationId: DEFAULT_ORG_ID },
    );

    await runPendingJobs({
      db,
      tasks,
      logger,
      services: {},
      limit: 1,
      processingOrder: (left, right) =>
        Number(right.input.priority) - Number(left.input.priority),
    });

    expect(handled).toEqual(["high"]);
  });

  it("skips an exclusive key that is already processing", async () => {
    const { db } = await createPGliteTestAdapter();
    const handled = vi.fn();
    const task = exclusiveTask(async () => {
      handled();
      return { output: {} };
    });
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);

    const processingId = await jobs.enqueue(
      task.slug,
      { key: "store-1" },
      { organizationId: DEFAULT_ORG_ID },
    );
    await db
      .update(commerceJobs)
      .set({ status: "processing", processingStartedAt: new Date() })
      .where(eq(commerceJobs.id, processingId));
    const pendingId = await jobs.enqueue(
      task.slug,
      { key: "store-1" },
      { organizationId: DEFAULT_ORG_ID },
    );

    expect(await runPendingJobs({ db, tasks, logger, services: {} })).toEqual({
      processed: 0,
      failed: 0,
    });
    expect(handled).not.toHaveBeenCalled();
    expect(
      (
        await db
          .select()
          .from(commerceJobs)
          .where(eq(commerceJobs.id, pendingId))
      )[0]?.status,
    ).toBe("pending");
  });
});
