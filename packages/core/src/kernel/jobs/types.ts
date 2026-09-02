import type { Logger, ServiceContainer } from "../hooks/types.js";
import type { DrizzleDatabase } from "../database/drizzle-db.js";

export const BUILTIN_JOB_TASK_SLUGS = {
  webhookDeliver: "webhooks/deliver",
  staleJobReaper: "jobs/reap-stale",
} as const;

export interface TaskContext {
  logger: Logger;
  db: DrizzleDatabase;
  services: ServiceContainer;
  /** Durable per-phase execution, backed by the Workflow step on Cloudflare and a
   * pass-through implementation on the drizzle engine. Absent on engines (pg-boss,
   * Inngest, Trigger) that have not wired one; a handler that ignores it runs as before. */
  step?: TaskStep;
}

/** Durable, idempotent execution of one phase of a task handler. */
export interface TaskStep {
  do<T>(
    name: string,
    fn: () => Promise<T>,
    options?: {
      retries?: TaskRetryConfig;
      timeout?: number;
      nonRetryable?: boolean;
    },
  ): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

/** Thrown by a task handler (or a step's callback) to signal the failure must not be
 * retried — the Cloudflare engine maps it to `NonRetryableError`; the drizzle runner
 * fails the job immediately regardless of remaining attempts. */
export class TaskNonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNonRetryableError";
  }
}

export type JobInstanceStatus =
  | "queued"
  | "running"
  | "waiting"
  | "complete"
  | "errored"
  | "terminated";

export interface TaskRetryConfig {
  attempts: number;
  backoff?: { type: "fixed" | "exponential"; delay: number };
}

export interface JobProcessingOrderRecord {
  id: string;
  taskSlug: string;
  input: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export type JobProcessingOrderField =
  | "createdAt"
  | "updatedAt"
  | "attempts"
  | "taskSlug";

export type JobProcessingOrder =
  | {
      field: JobProcessingOrderField;
      direction?: "asc" | "desc";
    }
  | ((
      left: JobProcessingOrderRecord,
      right: JobProcessingOrderRecord,
    ) => number);

/** Present when the handler is invoked by `runPendingJobs` (not for ad-hoc calls). */
export interface TaskJobMeta {
  attemptNumber: number;
  maxAttempts: number;
}

export interface TaskDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> {
  slug: string;
  handler: (args: {
    input: TInput;
    ctx: TaskContext;
    job?: TaskJobMeta;
  }) => Promise<{ output: TOutput }>;
  retries?: TaskRetryConfig;
  /** The handler drives its own durable phases through `ctx.step` and keeps every
   * side effect inside one. A push engine with a step primitive (Cloudflare) then
   * runs the handler directly — each `ctx.step.do` is a real step with its own
   * retries and `retries` above is only the per-step default — instead of
   * wrapping the whole handler in one retried unit; `job.attemptNumber` is then
   * always 1, because retries happen per step. Pull engines ignore it. */
  durableSteps?: boolean;
  concurrency?: {
    key: (input: TInput) => string;
    exclusive?: boolean;
    supersedes?: boolean;
  };
}
