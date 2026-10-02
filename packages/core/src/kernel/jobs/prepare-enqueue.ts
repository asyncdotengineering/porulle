import { OrgResolutionError } from "../errors.js";
import type { EnqueueOptions } from "./adapter.js";
import type { TaskDefinition } from "./types.js";

export interface PreparedEnqueue {
  task: TaskDefinition;
  organizationId: string;
  concurrencyKey: string | undefined;
  /** At most one running job per concurrency key. */
  exclusive: boolean;
  /** A newer enqueue replaces a pending one with the same concurrency key. */
  supersedes: boolean;
  maxAttempts: number;
}

/**
 * The validation and defaulting every execution engine applies before it hands
 * a job to its backend: the task must be registered, the organization must be
 * non-blank, and concurrency/retry settings come from the task unless the
 * enqueue call overrides them.
 */
export function prepareEnqueue(
  tasks: ReadonlyMap<string, TaskDefinition>,
  taskSlug: string,
  input: Record<string, unknown>,
  options: EnqueueOptions,
): PreparedEnqueue {
  const task = tasks.get(taskSlug);
  if (!task) throw new Error(`Unknown task slug: ${taskSlug}`);
  const organizationId = options.organizationId.trim();
  if (!organizationId) {
    throw new OrgResolutionError("Jobs enqueue requires a non-empty organizationId.");
  }
  return {
    task,
    organizationId,
    concurrencyKey: options.concurrencyKey ?? task.concurrency?.key(input),
    exclusive: Boolean(task.concurrency && task.concurrency.exclusive !== false),
    supersedes: Boolean(options.supersedes ?? task.concurrency?.supersedes),
    maxAttempts: options.maxAttempts ?? task.retries?.attempts ?? 1,
  };
}
