/**
 * Minimal interface for enqueueing background jobs.
 * The full DrizzleJobsAdapter implements this; hooks receive
 * it on HookContext.jobs so they can defer work without caring
 * about the underlying storage.
 */
export interface JobsAdapter {
  enqueue(
    taskSlug: string,
    input: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<string>;
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
 * No-op adapter used when no jobs backend is configured.
 * All enqueue calls silently succeed and return a placeholder ID.
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
