import { eq, and, sql } from "drizzle-orm";
import type { DrizzleDatabase } from "../database/drizzle-db.js";
import type { Logger, ServiceContainer } from "../hooks/types.js";
import type { JobProcessingOrder, TaskDefinition } from "./types.js";
import { commerceJobs } from "./schema.js";

export interface RunPendingJobsArgs {
  db: DrizzleDatabase;
  tasks: Map<string, TaskDefinition>;
  queue?: string;
  limit?: number;
  processingOrder?: JobProcessingOrder;
  logger: Logger;
  services: ServiceContainer;
}

type CommerceJob = typeof commerceJobs.$inferSelect;

function isExclusiveTask(task: TaskDefinition | undefined): boolean {
  return Boolean(task?.concurrency && task.concurrency.exclusive !== false);
}

function compareByProcessingOrder(
  processingOrder: JobProcessingOrder | undefined,
): (left: CommerceJob, right: CommerceJob) => number {
  if (typeof processingOrder === "function") {
    return (left, right) =>
      processingOrder(
        {
          ...left,
          input: left.input as Record<string, unknown>,
        },
        {
          ...right,
          input: right.input as Record<string, unknown>,
        },
      );
  }

  const field = processingOrder?.field ?? "createdAt";
  const direction = processingOrder?.direction === "desc" ? -1 : 1;
  return (left, right) => {
    const leftValue = left[field];
    const rightValue = right[field];
    const compared =
      leftValue instanceof Date && rightValue instanceof Date
        ? leftValue.getTime() - rightValue.getTime()
        : typeof leftValue === "number" && typeof rightValue === "number"
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue));
    if (compared !== 0) return compared * direction;
    return (
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.id.localeCompare(right.id)
    );
  };
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
    processingOrder,
    logger,
    services,
  } = args;

  // Phase 1: Claim jobs atomically
  const claimed = await db.transaction(async (tx) => {
    const processing = await tx
      .select({ concurrencyKey: commerceJobs.concurrencyKey })
      .from(commerceJobs)
      .where(eq(commerceJobs.status, "processing"));
    const processingKeys = new Set(
      processing.flatMap((job) =>
        job.concurrencyKey ? [job.concurrencyKey] : [],
      ),
    );

    const candidates = await tx
      .select()
      .from(commerceJobs)
      .where(
        and(
          eq(commerceJobs.status, "pending"),
          eq(commerceJobs.queue, queue),
          sql`(${commerceJobs.waitUntil} IS NULL OR ${commerceJobs.waitUntil} <= now())`,
        ),
      )
      .orderBy(commerceJobs.createdAt);

    candidates.sort(compareByProcessingOrder(processingOrder));

    const pending: CommerceJob[] = [];
    for (const candidate of candidates) {
      if (pending.length >= limit) break;
      if (
        candidate.concurrencyKey &&
        isExclusiveTask(tasks.get(candidate.taskSlug)) &&
        processingKeys.has(candidate.concurrencyKey)
      ) {
        continue;
      }

      const [locked] = await tx
        .select()
        .from(commerceJobs)
        .where(
          and(
            eq(commerceJobs.id, candidate.id),
            eq(commerceJobs.status, "pending"),
          ),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (locked) pending.push(locked);
    }

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

    const oldestByKey = new Map<string, CommerceJob>();
    const jobsToRun: CommerceJob[] = [];
    const jobsToRelease: CommerceJob[] = [];

    for (const job of pending) {
      if (!job.concurrencyKey || !isExclusiveTask(tasks.get(job.taskSlug))) {
        jobsToRun.push(job);
        continue;
      }

      const oldest = oldestByKey.get(job.concurrencyKey);
      if (!oldest) {
        oldestByKey.set(job.concurrencyKey, job);
        continue;
      }

      if (job.createdAt < oldest.createdAt) {
        oldestByKey.set(job.concurrencyKey, job);
        jobsToRelease.push(oldest);
      } else {
        jobsToRelease.push(job);
      }
    }

    jobsToRun.push(...oldestByKey.values());

    for (const job of jobsToRelease) {
      await tx
        .update(commerceJobs)
        .set({
          status: "pending",
          processingStartedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(commerceJobs.id, job.id));
    }

    return jobsToRun.sort(compareByProcessingOrder(processingOrder));
  });

  // Phase 2: Execute each claimed job outside the claim transaction
  const outcomes = await Promise.all(
    claimed.map(async (job) => {
      const task = tasks.get(job.taskSlug);

      if (!task) {
        logger.warn(
          "Unknown task slug — job marked as failed. Register the task handler in config.jobs.tasks.",
          {
            taskSlug: job.taskSlug,
            jobId: job.id,
          },
        );
        await db
          .update(commerceJobs)
          .set({
            status: "failed",
            error: `Unknown task slug: ${job.taskSlug}`,
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(commerceJobs.id, job.id));
        return "failed" as const;
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

        return "processed" as const;
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
          return "failed" as const;
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
              processingStartedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(commerceJobs.id, job.id));
          return "retrying" as const;
        }
      }
    }),
  );

  return {
    processed: outcomes.filter((outcome) => outcome === "processed").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
  };
}
