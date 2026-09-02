import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { CommerceNotFoundError } from "../src/kernel/errors.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { runPendingJobs } from "../src/kernel/jobs/runner.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

const task: TaskDefinition = {
  slug: "test/status",
  handler: async () => ({ output: {} }),
};

describe("DrizzleJobsAdapter status/cancel", () => {
  it("maps a pending job to queued", async () => {
    const { db } = await createPGliteTestAdapter();
    const jobs = new DrizzleJobsAdapter(db, new Map([[task.slug, task]]));
    const jobId = await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });

    await expect(jobs.status(jobId)).resolves.toEqual({ status: "queued" });
  });

  it("maps processing, succeeded, and failed jobs to running, complete, and errored", async () => {
    const { db } = await createPGliteTestAdapter();
    const jobs = new DrizzleJobsAdapter(db, new Map([[task.slug, task]]));
    const jobId = await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });

    await db.update(commerceJobs).set({ status: "processing" }).where(eq(commerceJobs.id, jobId));
    await expect(jobs.status(jobId)).resolves.toEqual({ status: "running" });

    await db.update(commerceJobs).set({ status: "succeeded" }).where(eq(commerceJobs.id, jobId));
    await expect(jobs.status(jobId)).resolves.toEqual({ status: "complete" });

    await db
      .update(commerceJobs)
      .set({ status: "failed", error: "boom" })
      .where(eq(commerceJobs.id, jobId));
    await expect(jobs.status(jobId)).resolves.toEqual({ status: "errored", error: "boom" });
  });

  it("throws CommerceNotFoundError for an unknown job id", async () => {
    const { db } = await createPGliteTestAdapter();
    const jobs = new DrizzleJobsAdapter(db, new Map([[task.slug, task]]));

    await expect(jobs.status("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      CommerceNotFoundError,
    );
  });

  it("cancel marks a pending job cancelled and reports it as terminated", async () => {
    const { db } = await createPGliteTestAdapter();
    const tasks = new Map([[task.slug, task]]);
    const jobs = new DrizzleJobsAdapter(db, tasks);
    const jobId = await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });

    await jobs.cancel(jobId);
    await expect(jobs.status(jobId)).resolves.toEqual({ status: "terminated" });
    // A cancelled row is never picked up by the runner.
    expect(await runPendingJobs({ db, tasks, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, services: {} })).toEqual({
      processed: 0,
      failed: 0,
    });
  });

  it("cancel leaves a processing job untouched", async () => {
    const { db } = await createPGliteTestAdapter();
    const jobs = new DrizzleJobsAdapter(db, new Map([[task.slug, task]]));
    const jobId = await jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID });
    await db.update(commerceJobs).set({ status: "processing" }).where(eq(commerceJobs.id, jobId));

    await jobs.cancel(jobId);
    const [row] = await db.select().from(commerceJobs).where(eq(commerceJobs.id, jobId));
    expect(row?.status).toBe("processing");
  });
});
