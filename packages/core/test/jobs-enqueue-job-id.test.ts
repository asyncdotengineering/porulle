import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

describe("DrizzleJobsAdapter enqueue jobId", () => {
  it("uses a caller-supplied jobId as the commerce_jobs row id", async () => {
    const { db } = await createPGliteTestAdapter();
    const task: TaskDefinition = {
      slug: "test/keyed-id",
      handler: async () => ({ output: {} }),
    };
    const jobs = new DrizzleJobsAdapter(db, new Map([[task.slug, task]]));
    const jobId = "6f1c2a4e-3b7d-4c9e-8a5f-1d2e3f4a5b6c";

    await expect(
      jobs.enqueue(task.slug, {}, { organizationId: DEFAULT_ORG_ID, jobId }),
    ).resolves.toBe(jobId);
    const [row] = await db
      .select({ id: commerceJobs.id })
      .from(commerceJobs)
      .where(eq(commerceJobs.id, jobId));
    expect(row?.id).toBe(jobId);
    await expect(jobs.status(jobId)).resolves.toEqual({ status: "queued" });
  });
});
