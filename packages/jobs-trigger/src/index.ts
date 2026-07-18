import {
  task as createTriggerTask,
  tasks as triggerTasks,
} from "@trigger.dev/sdk";
import type { AnyTask } from "@trigger.dev/sdk";
import type {
  EnqueueOptions,
  ExecutionEngine,
  ExecutionEngineSetup,
  TaskDefinition,
} from "@porulle/core";

interface TriggerJobPayload {
  input: Record<string, unknown>;
  organizationId: string;
  maxAttempts: number;
  concurrencyKey?: string;
}

type DebounceDelay = "1s" | "2s" | "5s" | "10s" | "30s" | "1m";

export interface TriggerExecutionEngineOptions {
  queuePrefix?: string;
  supersedesDebounce?: DebounceDelay;
}

export class TriggerExecutionEngine implements ExecutionEngine {
  readonly execution = { mode: "push" as const };
  readonly tasks: AnyTask[] = [];

  private readonly queuePrefix: string;
  private readonly supersedesDebounce: DebounceDelay;
  private setup: ExecutionEngineSetup | undefined;

  constructor(options: TriggerExecutionEngineOptions = {}) {
    this.queuePrefix = options.queuePrefix ?? "porulle";
    this.supersedesDebounce = options.supersedesDebounce ?? "1s";
  }

  register(setup: ExecutionEngineSetup): void {
    this.setup = setup;
    this.tasks.splice(0, this.tasks.length);
    for (const definition of setup.tasks.values()) {
      this.tasks.push(this.createTask(definition));
    }
  }

  async enqueue(
    taskSlug: string,
    input: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<string> {
    const definition = this.requireSetup().tasks.get(taskSlug);
    if (!definition) throw new Error(`Unknown task slug: ${taskSlug}`);
    const organizationId = options.organizationId.trim();
    if (!organizationId)
      throw new Error("Jobs enqueue requires a non-empty organizationId.");

    const concurrencyKey =
      options.concurrencyKey ?? definition.concurrency?.key(input);
    const exclusive = Boolean(
      definition.concurrency && definition.concurrency.exclusive !== false,
    );
    const supersedes = options.supersedes ?? definition.concurrency?.supersedes;
    const maxAttempts =
      options.maxAttempts ?? definition.retries?.attempts ?? 1;
    const payload: TriggerJobPayload = {
      input,
      organizationId,
      maxAttempts,
      ...(concurrencyKey ? { concurrencyKey } : {}),
    };
    const handle = await triggerTasks.trigger(taskSlug, payload, {
      maxAttempts,
      ...(exclusive && concurrencyKey ? { concurrencyKey } : {}),
      ...(options.delayMs !== undefined
        ? { delay: new Date(Date.now() + options.delayMs) }
        : {}),
      ...(supersedes && concurrencyKey
        ? {
            debounce: {
              key: concurrencyKey,
              delay: this.supersedesDebounce,
              mode: "trailing" as const,
            },
          }
        : {}),
    });
    return handle.id;
  }

  private createTask(definition: TaskDefinition): AnyTask {
    const exclusive = Boolean(
      definition.concurrency && definition.concurrency.exclusive !== false,
    );
    const retry = this.translateRetry(definition);
    return createTriggerTask({
      id: definition.slug,
      ...(exclusive
        ? {
            queue: {
              name: `${this.queuePrefix}-${definition.slug.replaceAll("/", "-")}`,
              concurrencyLimit: 1,
            },
          }
        : {}),
      ...(retry ? { retry } : {}),
      run: async (payload: TriggerJobPayload, { ctx }) => {
        const result = await definition.handler({
          input: payload.input,
          ctx: this.requireSetup().context,
          job: {
            attemptNumber: ctx.attempt.number,
            maxAttempts: payload.maxAttempts,
          },
        });
        return result.output;
      },
    });
  }

  private translateRetry(definition: TaskDefinition) {
    const retries = definition.retries;
    if (!retries) return undefined;
    const delay = retries.backoff?.delay ?? 1_000;
    return {
      maxAttempts: retries.attempts,
      factor: retries.backoff?.type === "exponential" ? 2 : 1,
      minTimeoutInMs: delay,
      ...(retries.backoff?.type === "fixed" ? { maxTimeoutInMs: delay } : {}),
      randomize: false,
    };
  }

  private requireSetup(): ExecutionEngineSetup {
    if (!this.setup)
      throw new Error("TriggerExecutionEngine must be registered before use.");
    return this.setup;
  }
}
