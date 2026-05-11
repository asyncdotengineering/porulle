import { eq, and, sql } from "drizzle-orm";
import type { DrizzleDatabase } from "../database/drizzle-db.js";
import type { Logger, ServiceContainer } from "../hooks/types.js";
import type { TaskDefinition } from "./types.js";
import { commerceJobs } from "./schema.js";

export interface RunPendingJobsArgs {
  db: DrizzleDatabase;
  tasks: Map<string, TaskDefinition>;
  queue?: string;
  limit?: number;
  logger: Logger;
  services: ServiceContainer;
}

/**
 * Claims and processes pending jobs from the `commerce_jobs` table.
 *
 * Uses `FOR UPDATE SKIP LOCKED` to allow multiple runners to process
 * jobs in parallel without conflicts. Each runner claims a batch,
 * marks them as processing, then executes handlers outside the
 * claim transaction.
 */
export async function runPendingJobs(
  args: RunPendingJobsArgs,
): Promise<{ processed: number; failed: number }> {
  const {
    db,
    tasks,
    queue = "default",
    limit = 10,
    logger,
    services,
  } = args;

  let processed = 0;
  let failed = 0;

  // Phase 1: Claim jobs atomically
  const claimed = await db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(commerceJobs)
      .where(
        and(
          eq(commerceJobs.status, "pending"),
          eq(commerceJobs.queue, queue),
          sql`(${commerceJobs.waitUntil} IS NULL OR ${commerceJobs.waitUntil} <= now())`,
        ),
      )
      .orderBy(commerceJobs.createdAt)
      .limit(limit)
      .for("update", { skipLocked: true });

    for (const job of pending) {
      await tx
        .update(commerceJobs)
        .set({
          status: "processing",
          processingStartedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(commerceJobs.id, job.id));
    }

    return pending;
  });

  // Phase 2: Execute each claimed job outside the claim transaction
  for (const job of claimed) {
    const task = tasks.get(job.taskSlug);

    if (!task) {
      logger.warn("Unknown task slug — job marked as failed. Register the task handler in config.jobs.tasks.", {
        taskSlug: job.taskSlug,
        jobId: job.id,
      });
      await db
        .update(commerceJobs)
        .set({
          status: "failed",
          error: `Unknown task slug: ${job.taskSlug}`,
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(commerceJobs.id, job.id));
      failed++;
      continue;
    }

    try {
      const result = await task.handler({
        input: job.input as Record<string, unknown>,
        ctx: { logger, db, services },
        job: {
          attemptNumber: job.attempts + 1,
          maxAttempts: job.maxAttempts,
        },
      });

      await db
        .update(commerceJobs)
        .set({
          status: "succeeded",
          output: result.output,
          attempts: job.attempts + 1,
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(commerceJobs.id, job.id));

      processed++;
    } catch (err) {
      logger.error("Job handler failed", {
        taskSlug: job.taskSlug,
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
      const attempts = job.attempts + 1;
      const maxAttempts = job.maxAttempts;

      if (attempts >= maxAttempts) {
        await db
          .update(commerceJobs)
          .set({
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            attempts,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(commerceJobs.id, job.id));
        failed++;
      } else {
        // Compute backoff delay
        const retries = task.retries;
        const delay =
          retries?.backoff?.type === "exponential"
            ? retries.backoff.delay * Math.pow(2, attempts - 1)
            : (retries?.backoff?.delay ?? 1000);

        await db
          .update(commerceJobs)
          .set({
            status: "pending",
            error: err instanceof Error ? err.message : String(err),
            attempts,
            waitUntil: new Date(Date.now() + delay),
            updatedAt: new Date(),
          })
          .where(eq(commerceJobs.id, job.id));
      }
    }
  }

  return { processed, failed };
}
