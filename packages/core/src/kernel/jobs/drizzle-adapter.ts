import { eq, and } from "drizzle-orm";
import type { DrizzleDatabase } from "../database/drizzle-db.js";
import type { TaskDefinition } from "./types.js";
import type { JobsAdapter, EnqueueOptions } from "./adapter.js";
import { OrgResolutionError } from "../errors.js";
import { commerceJobs } from "./schema.js";

/**
 * PostgreSQL-backed job queue adapter using the application's own database.
 * Stores jobs in the `commerce_jobs` table. Supports concurrency keys
 * and supersede semantics for deduplication.
 */
export class DrizzleJobsAdapter implements JobsAdapter {
  constructor(
    private db: DrizzleDatabase,
    private tasks: Map<string, TaskDefinition>,
  ) {}

  async enqueue(
    taskSlug: string,
    input: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<string> {
    const organizationId = options.organizationId.trim();
    if (!organizationId) {
      throw new OrgResolutionError(
        "Jobs enqueue requires a non-empty organizationId.",
      );
    }

    // If supersedes is set, delete existing pending jobs with the same concurrency key
    if (options.concurrencyKey && options.supersedes) {
      await this.db
        .delete(commerceJobs)
        .where(
          and(
            eq(commerceJobs.concurrencyKey, options.concurrencyKey),
            eq(commerceJobs.status, "pending"),
          ),
        );
    }

    // Look up task definition for default retry config
    const task = this.tasks.get(taskSlug);
    const maxAttempts =
      options.maxAttempts ?? task?.retries?.attempts ?? 1;

    const rows = await this.db
      .insert(commerceJobs)
      .values({
        organizationId,
        taskSlug,
        input,
        queue: options.queue ?? "default",
        maxAttempts,
        waitUntil: options.delayMs
          ? new Date(Date.now() + options.delayMs)
          : null,
        concurrencyKey: options.concurrencyKey ?? null,
      })
      .returning({ id: commerceJobs.id });

    return rows[0]!.id;
  }
}
