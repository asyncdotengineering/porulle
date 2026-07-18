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
}

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
  concurrency?: {
    key: (input: TInput) => string;
    exclusive?: boolean;
    supersedes?: boolean;
  };
}
