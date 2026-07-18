import type {
  JobProcessingOrder,
  TaskContext,
  TaskDefinition,
} from "./types.js";

/** Enqueue-only surface exposed to hooks and services. */
export interface JobsAdapter {
  enqueue(
    taskSlug: string,
    input: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<string>;
}

export interface RunJobsOptions {
  queue?: string;
  limit?: number;
}

export interface RunJobsResult {
  processed: number;
  failed: number;
}

export interface ExecutionEngineSetup {
  tasks: ReadonlyMap<string, TaskDefinition>;
  context: TaskContext;
  processingOrder?: JobProcessingOrder;
}

export type ExecutionDriver =
  | {
      mode: "pull";
      run(options?: RunJobsOptions): Promise<RunJobsResult>;
    }
  | {
      mode: "push";
    };

/** Full job-engine contract selected through `config.jobs.adapter`. */
export interface ExecutionEngine extends JobsAdapter {
  readonly execution: ExecutionDriver;
  register(setup: ExecutionEngineSetup): void;
}

export interface EnqueueOptions {
  organizationId: string;
  queue?: string;
  maxAttempts?: number;
  delayMs?: number;
  concurrencyKey?: string;
  supersedes?: boolean;
}

/**
 * No-op enqueue surface used by isolated hook contexts.
 */
export class NullJobsAdapter implements JobsAdapter {
  async enqueue(
    _taskSlug: string,
    _input: Record<string, unknown>,
    _options: EnqueueOptions,
  ): Promise<string> {
    return "null-job-id";
  }
}
