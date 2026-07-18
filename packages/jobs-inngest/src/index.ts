import { Inngest } from "inngest";
import type {
  EnqueueOptions,
  ExecutionEngine,
  ExecutionEngineSetup,
  TaskDefinition,
} from "@porulle/core";

interface InngestJobData extends Record<string, unknown> {
  input: Record<string, unknown>;
  organizationId: string;
  maxAttempts: number;
  concurrencyKey?: string;
}

type InngestFunction = ReturnType<Inngest["createFunction"]>;
type DebouncePeriod = "1s" | "2s" | "5s" | "10s" | "30s" | "1m";
const INNGEST_RETRY_VALUES = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;

export interface InngestExecutionEngineOptions {
  client?: Inngest;
  appId?: string;
  eventPrefix?: string;
  supersedesDebounce?: DebouncePeriod;
}

export class InngestExecutionEngine implements ExecutionEngine {
  readonly execution = { mode: "push" as const };
  readonly functions: InngestFunction[] = [];

  private readonly client: Inngest;
  private readonly eventPrefix: string;
  private readonly supersedesDebounce: DebouncePeriod;
  private setup: ExecutionEngineSetup | undefined;

  constructor(options: InngestExecutionEngineOptions = {}) {
    this.client =
      options.client ?? new Inngest({ id: options.appId ?? "porulle" });
    this.eventPrefix = options.eventPrefix ?? "porulle/job";
    this.supersedesDebounce = options.supersedesDebounce ?? "1s";
  }

  register(setup: ExecutionEngineSetup): void {
    this.setup = setup;
    this.functions.splice(0, this.functions.length);
    for (const task of setup.tasks.values()) {
      this.functions.push(this.createFunction(task));
    }
  }

  async enqueue(
    taskSlug: string,
    input: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<string> {
    const task = this.requireSetup().tasks.get(taskSlug);
    if (!task) throw new Error(`Unknown task slug: ${taskSlug}`);
    const organizationId = options.organizationId.trim();
    if (!organizationId)
      throw new Error("Jobs enqueue requires a non-empty organizationId.");
    const taskMaxAttempts = task.retries?.attempts ?? 1;
    if (
      options.maxAttempts !== undefined &&
      options.maxAttempts !== taskMaxAttempts
    ) {
      throw new Error(
        "Inngest retry counts are fixed when functions are registered; configure retries on TaskDefinition instead of enqueue().",
      );
    }
    const taskSupersedes = Boolean(task.concurrency?.supersedes);
    if (
      options.supersedes !== undefined &&
      options.supersedes !== taskSupersedes
    ) {
      throw new Error(
        "Inngest debounce is fixed when functions are registered; configure supersedes on TaskDefinition instead of enqueue().",
      );
    }

    const concurrencyKey =
      options.concurrencyKey ?? task.concurrency?.key(input);
    const data: InngestJobData = {
      input,
      organizationId,
      maxAttempts: taskMaxAttempts,
      ...(concurrencyKey ? { concurrencyKey } : {}),
    };
    const result = await this.client.send({
      name: this.eventName(taskSlug),
      data,
      ...(options.delayMs !== undefined
        ? { ts: Date.now() + options.delayMs }
        : {}),
    });
    const id = result.ids[0];
    if (!id) throw new Error("Inngest did not return an event id.");
    return id;
  }

  private createFunction(task: TaskDefinition): InngestFunction {
    const exclusive = Boolean(
      task.concurrency && task.concurrency.exclusive !== false,
    );
    const retries =
      INNGEST_RETRY_VALUES[
        Math.min(Math.max((task.retries?.attempts ?? 1) - 1, 0), 20)
      ]!;
    return this.client.createFunction(
      {
        id: `porulle:${task.slug}`,
        triggers: [{ event: this.eventName(task.slug) }],
        retries,
        ...(exclusive
          ? { concurrency: { limit: 1, key: "event.data.concurrencyKey" } }
          : {}),
        ...(task.concurrency?.supersedes
          ? {
              debounce: {
                key: "event.data.concurrencyKey",
                period: this.supersedesDebounce,
              },
            }
          : {}),
      },
      async ({ event, attempt }) => {
        const data = event.data as InngestJobData;
        const result = await task.handler({
          input: data.input,
          ctx: this.requireSetup().context,
          job: {
            attemptNumber: attempt + 1,
            maxAttempts: data.maxAttempts,
          },
        });
        return result.output;
      },
    );
  }

  private eventName(taskSlug: string): string {
    return `${this.eventPrefix}/${taskSlug}`;
  }

  private requireSetup(): ExecutionEngineSetup {
    if (!this.setup)
      throw new Error("InngestExecutionEngine must be registered before use.");
    return this.setup;
  }
}
