import { eq, and } from "drizzle-orm";
import type { DrizzleDatabase } from "../database/drizzle-db.js";
import type { TaskDefinition } from "./types.js";
import type {
  EnqueueOptions,
  ExecutionEngine,
  ExecutionEngineSetup,
  RunJobsOptions,
} from "./adapter.js";
import { OrgResolutionError } from "../errors.js";
import { commerceJobs } from "./schema.js";
import { runPendingJobs } from "./runner.js";
import {
  getJobReapThresholdMs,
  getJobsReaperIntervalMs,
  runStaleJobReaper,
} from "./reaper.js";

/**
 * PostgreSQL-backed job queue adapter using the application's own database.
 * Stores jobs in the `commerce_jobs` table. Supports concurrency keys
 * and supersede semantics for deduplication.
 */
export class DrizzleJobsAdapter implements ExecutionEngine {
  private setup: ExecutionEngineSetup | undefined;
  private lastStaleJobReaperAt = 0;

  readonly execution = {
    mode: "pull" as const,
    run: async (options: RunJobsOptions = {}) => {
      if (!this.setup) {
        throw new Error(
          "DrizzleJobsAdapter must be registered before running jobs.",
        );
      }

      const now = Date.now();
      if (now - this.lastStaleJobReaperAt >= getJobsReaperIntervalMs()) {
        this.lastStaleJobReaperAt = now;
        try {
          await runStaleJobReaper(
            this.db,
            getJobReapThresholdMs(),
            this.setup.context.logger,
          );
        } catch (error) {
          this.setup.context.logger.error("Stale job reaper failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return runPendingJobs({
        db: this.db,
        tasks: new Map(this.setup.tasks),
        logger: this.setup.context.logger,
        services: this.setup.context.services,
        ...(options.queue !== undefined ? { queue: options.queue } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(this.setup.processingOrder !== undefined
          ? { processingOrder: this.setup.processingOrder }
          : {}),
      });
    },
  };

  constructor(
    private db: DrizzleDatabase,
    private tasks: Map<string, TaskDefinition> = new Map(),
  ) {}

  register(setup: ExecutionEngineSetup): void {
    this.setup = setup;
    this.tasks = new Map(setup.tasks);
  }

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

    const task = this.tasks.get(taskSlug);
    const concurrencyKey =
      options.concurrencyKey ?? task?.concurrency?.key(input);
    const supersedes = options.supersedes ?? task?.concurrency?.supersedes;

    // If supersedes is set, delete existing pending jobs with the same concurrency key
    if (concurrencyKey && supersedes) {
      await this.db
        .delete(commerceJobs)
        .where(
          and(
            eq(commerceJobs.organizationId, organizationId),
            eq(commerceJobs.taskSlug, taskSlug),
            eq(commerceJobs.concurrencyKey, concurrencyKey),
            eq(commerceJobs.status, "pending"),
          ),
        );
    }

    // Look up task definition for default retry config
    const maxAttempts = options.maxAttempts ?? task?.retries?.attempts ?? 1;

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
        concurrencyKey: concurrencyKey ?? null,
      })
      .returning({ id: commerceJobs.id });

    return rows[0]!.id;
  }
}
