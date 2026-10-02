import {
  task as createTriggerTask,
  tasks as triggerTasks,
} from "@trigger.dev/sdk";
import { prepareEnqueue } from "@porulle/core/jobs";
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
    const prepared = prepareEnqueue(this.requireSetup().tasks, taskSlug, input, options);
    const payload: TriggerJobPayload = {
      input,
      organizationId: prepared.organizationId,
      maxAttempts: prepared.maxAttempts,
      ...(prepared.concurrencyKey ? { concurrencyKey: prepared.concurrencyKey } : {}),
    };
    const handle = await triggerTasks.trigger(taskSlug, payload, {
      maxAttempts: prepared.maxAttempts,
      ...(prepared.exclusive && prepared.concurrencyKey
        ? { concurrencyKey: prepared.concurrencyKey }
        : {}),
      ...(options.delayMs !== undefined
        ? { delay: new Date(Date.now() + options.delayMs) }
        : {}),
      ...(prepared.supersedes && prepared.concurrencyKey
        ? {
            debounce: {
              key: prepared.concurrencyKey,
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
