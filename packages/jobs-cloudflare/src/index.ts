import type {
  EnqueueOptions,
  ExecutionEngine,
  ExecutionEngineSetup,
} from "@porulle/core";

export interface CloudflareJobPayload {
  taskSlug: string;
  input: Record<string, unknown>;
  organizationId: string;
  maxAttempts: number;
  delayMs?: number;
  concurrencyKey?: string;
  exclusive: boolean;
  supersedes: boolean;
}

export interface WorkflowBinding {
  create(options: {
    id?: string;
    params: CloudflareJobPayload;
  }): Promise<{ id: string }>;
}

export interface WorkflowStep {
  sleep(name: string, duration: number | string): Promise<void>;
  do<T>(
    name: string,
    config: {
      retries: {
        limit: number;
        delay: number;
        backoff: "constant" | "exponential";
      };
    },
    callback: (context: { attempt: number }) => Promise<T>,
  ): Promise<T>;
}

export interface CloudflareConcurrencyCoordinator {
  enqueue(
    payload: CloudflareJobPayload,
    create: () => Promise<{ id: string }>,
  ): Promise<{ id: string }>;
  run<T>(key: string, handler: () => Promise<T>): Promise<T>;
}

export interface CloudflareExecutionEngineOptions {
  workflow: WorkflowBinding;
  coordinator?: CloudflareConcurrencyCoordinator;
}

export class CloudflareExecutionEngine implements ExecutionEngine {
  readonly execution = { mode: "push" as const };
  private setup: ExecutionEngineSetup | undefined;

  constructor(private readonly options: CloudflareExecutionEngineOptions) {}

  register(setup: ExecutionEngineSetup): void {
    this.setup = setup;
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

    const concurrencyKey =
      options.concurrencyKey ?? task.concurrency?.key(input);
    const exclusive = Boolean(
      task.concurrency && task.concurrency.exclusive !== false,
    );
    const supersedes = Boolean(
      options.supersedes ?? task.concurrency?.supersedes,
    );
    if (
      (exclusive || supersedes) &&
      concurrencyKey &&
      !this.options.coordinator
    ) {
      throw new Error(
        "Cloudflare Workflows has no per-key queue concurrency primitive. Configure a durable CloudflareConcurrencyCoordinator for exclusive or superseding tasks.",
      );
    }

    const payload: CloudflareJobPayload = {
      taskSlug,
      input,
      organizationId,
      maxAttempts: options.maxAttempts ?? task.retries?.attempts ?? 1,
      exclusive,
      supersedes,
      ...(options.delayMs !== undefined ? { delayMs: options.delayMs } : {}),
      ...(concurrencyKey ? { concurrencyKey } : {}),
    };
    const create = () =>
      this.options.workflow.create({
        id: crypto.randomUUID(),
        params: payload,
      });
    const instance =
      this.options.coordinator && concurrencyKey
        ? await this.options.coordinator.enqueue(payload, create)
        : await create();
    return instance.id;
  }

  async run(
    payload: CloudflareJobPayload,
    step: WorkflowStep,
  ): Promise<Record<string, unknown>> {
    const setup = this.requireSetup();
    const task = setup.tasks.get(payload.taskSlug);
    if (!task) throw new Error(`Unknown task slug: ${payload.taskSlug}`);

    if (payload.delayMs && payload.delayMs > 0) {
      await step.sleep("porulle-delay", payload.delayMs);
    }
    const backoff = task.retries?.backoff;
    const execute = () =>
      step.do(
        `porulle:${payload.taskSlug}`,
        {
          retries: {
            limit: payload.maxAttempts,
            delay: backoff?.delay ?? 1_000,
            backoff:
              backoff?.type === "exponential" ? "exponential" : "constant",
          },
        },
        async ({ attempt }) => {
          const result = await task.handler({
            input: payload.input,
            ctx: setup.context,
            job: { attemptNumber: attempt, maxAttempts: payload.maxAttempts },
          });
          return result.output;
        },
      );

    if (payload.exclusive && payload.concurrencyKey) {
      if (!this.options.coordinator) {
        throw new Error(
          "Exclusive Cloudflare task requires a durable concurrency coordinator.",
        );
      }
      return this.options.coordinator.run(payload.concurrencyKey, execute);
    }
    return execute();
  }

  private requireSetup(): ExecutionEngineSetup {
    if (!this.setup)
      throw new Error(
        "CloudflareExecutionEngine must be registered before use.",
      );
    return this.setup;
  }
}
