import {
  TaskNonRetryableError,
  createPassThroughTaskStep,
} from "@porulle/core/jobs";
import type {
  EnqueueOptions,
  ExecutionEngine,
  ExecutionEngineSetup,
  JobInstanceStatus,
  TaskRetryConfig,
  TaskStep,
} from "@porulle/core/jobs";

export interface CloudflareJobPayload {
  /** This Workflow instance's own id — the value passed as `create({ id })`. */
  jobId: string;
  taskSlug: string;
  input: Record<string, unknown>;
  organizationId: string;
  maxAttempts: number;
  delayMs?: number;
  concurrencyKey?: string;
  exclusive: boolean;
  supersedes: boolean;
}

export interface WorkflowStepRetries {
  limit: number;
  delay: number;
  backoff: "constant" | "exponential";
}

export interface WorkflowStep {
  sleep(name: string, duration: number | string): Promise<void>;
  do<T>(
    name: string,
    config: { retries: WorkflowStepRetries; timeout?: number | string },
    callback: (context: { attempt: number }) => Promise<T>,
  ): Promise<T>;
  waitForEvent(
    name: string,
    options: { type: string; timeout?: number | string },
  ): Promise<unknown>;
}

export interface WorkflowInstanceHandle {
  status(): Promise<{ status: JobInstanceStatus; error?: string }>;
  terminate(): Promise<void>;
  sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
}

export interface WorkflowBinding {
  create(options: {
    id?: string;
    params: CloudflareJobPayload;
  }): Promise<{ id: string }>;
  get(id: string): Promise<WorkflowInstanceHandle>;
}

/** The shape of Cloudflare's own `Workflow` binding this package needs. */
export interface RawWorkflowBinding {
  create(options: { id?: string; params: CloudflareJobPayload }): Promise<{ id: string }>;
  get(id: string): Promise<{
    status(): Promise<{ status: string; error?: { name: string; message: string } }>;
    terminate(): Promise<void>;
    sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
  }>;
}

const INSTANCE_STATUS_MAP: Record<string, JobInstanceStatus> = {
  queued: "queued",
  running: "running",
  waiting: "waiting",
  paused: "waiting",
  waitingForPause: "waiting",
  complete: "complete",
  errored: "errored",
  terminated: "terminated",
};

/** Wraps the real Workflows binding: Cloudflare's richer instance status folds
 * into `JobInstanceStatus` (`paused`/`waitingForPause` → `waiting`, anything
 * unknown → `errored`) and the error becomes its message. */
export function adaptWorkflowBinding(binding: RawWorkflowBinding): WorkflowBinding {
  return {
    create: (options) => binding.create(options),
    async get(id) {
      const instance = await binding.get(id);
      return {
        async status() {
          const raw = await instance.status();
          return {
            status: INSTANCE_STATUS_MAP[raw.status] ?? "errored",
            ...(raw.error ? { error: raw.error.message } : {}),
          };
        },
        terminate: () => instance.terminate(),
        sendEvent: (event) => instance.sendEvent(event),
      };
    },
  };
}

export interface CloudflareConcurrencyCoordinator {
  enqueue(
    payload: CloudflareJobPayload,
    create: () => Promise<{ id: string }>,
  ): Promise<{ id: string }>;
  run<T>(
    payload: CloudflareJobPayload,
    step: WorkflowStep,
    handler: () => Promise<T>,
  ): Promise<T>;
}

export type NonRetryableErrorConstructor = new (message: string) => Error;

export interface CloudflareExecutionEngineOptions {
  workflow: WorkflowBinding;
  /** `NonRetryableError` from `cloudflare:workflows`. Workflows stops retrying a
   * step only for that exact class, and this package cannot import the module
   * outside the Workers runtime, so the Worker passes it in. */
  nonRetryableError: NonRetryableErrorConstructor;
  coordinator?: CloudflareConcurrencyCoordinator;
}

/** Cloudflare's `limit` counts retries after the first attempt; Porulle's
 * `attempts` counts every attempt. */
function toWorkflowStepRetries(
  config: TaskRetryConfig | undefined,
  attempts = config?.attempts ?? 1,
): WorkflowStepRetries {
  return {
    limit: Math.max(0, attempts - 1),
    delay: config?.backoff?.delay ?? 1_000,
    backoff: config?.backoff?.type === "exponential" ? "exponential" : "constant",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `fn` so that a refusal leaves it as Cloudflare's `NonRetryableError`.
 * Workflows honours that class only when it is thrown from inside the step
 * callback, so this wraps the callback itself, never the `step.do` call. */
function refusing<T>(
  NonRetryable: NonRetryableErrorConstructor,
  fn: () => Promise<T>,
  always = false,
): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (error) {
      if (always || error instanceof TaskNonRetryableError) {
        throw new NonRetryable(errorMessage(error));
      }
      throw error;
    }
  };
}

/** Backs `ctx.step` with the Workflow's own `step`, prefixing every step name
 * with `porulle:<slug>:`; each call is a top-level Workflow step with its own
 * retries and timeout. */
function createCloudflareTaskStep(
  step: WorkflowStep,
  taskSlug: string,
  defaults: TaskRetryConfig | undefined,
  NonRetryable: NonRetryableErrorConstructor,
): TaskStep {
  return {
    do(name, fn, options) {
      const config: { retries: WorkflowStepRetries; timeout?: number } = {
        retries: options?.nonRetryable
          ? { limit: 0, delay: 1_000, backoff: "constant" }
          : toWorkflowStepRetries(options?.retries ?? defaults),
        ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
      };
      return step.do(
        `porulle:${taskSlug}:${name}`,
        config,
        refusing(NonRetryable, fn, options?.nonRetryable === true),
      );
    },
    async sleep(name, ms) {
      await step.sleep(`porulle:${taskSlug}:${name}`, ms);
    },
  };
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

    const jobId = options.jobId ?? crypto.randomUUID();
    const payload: CloudflareJobPayload = {
      jobId,
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
      this.options.workflow.create({ id: jobId, params: payload });
    const coordinated = (exclusive || supersedes) && concurrencyKey;
    const instance =
      coordinated && this.options.coordinator
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
    const NonRetryable = this.options.nonRetryableError;

    if (payload.delayMs && payload.delayMs > 0) {
      await step.sleep("porulle-delay", payload.delayMs);
    }

    const invoke = async (taskStep: TaskStep, attemptNumber: number) => {
      const result = await task.handler({
        input: payload.input,
        ctx: { ...setup.context, step: taskStep },
        job: { attemptNumber, maxAttempts: payload.maxAttempts },
      });
      return result.output;
    };
    // Steps are never nested: a `durableSteps` handler runs in the Workflow body
    // and every `ctx.step.do` is a top-level step; any other handler is one step
    // retried as a unit, with a pass-through `ctx.step` inside it.
    const execute = task.durableSteps
      ? refusing(NonRetryable, () =>
          invoke(
            createCloudflareTaskStep(
              step,
              payload.taskSlug,
              task.retries,
              NonRetryable,
            ),
            1,
          ),
        )
      : () =>
          step.do(
            `porulle:${payload.taskSlug}`,
            {
              retries: toWorkflowStepRetries(task.retries, payload.maxAttempts),
            },
            ({ attempt }) =>
              refusing(NonRetryable, () =>
                invoke(createPassThroughTaskStep(), attempt),
              )(),
          );

    if (payload.exclusive && payload.concurrencyKey) {
      if (!this.options.coordinator) {
        throw new Error(
          "Exclusive Cloudflare task requires a durable concurrency coordinator.",
        );
      }
      return this.options.coordinator.run(payload, step, execute);
    }
    return execute();
  }

  async status(
    jobId: string,
  ): Promise<{ status: JobInstanceStatus; error?: string }> {
    const instance = await this.options.workflow.get(jobId);
    return instance.status();
  }

  async cancel(jobId: string): Promise<void> {
    const instance = await this.options.workflow.get(jobId);
    await instance.terminate();
  }

  private requireSetup(): ExecutionEngineSetup {
    if (!this.setup)
      throw new Error(
        "CloudflareExecutionEngine must be registered before use.",
      );
    return this.setup;
  }
}

export {
  DurableObjectConcurrencyCoordinator,
  JobCoordinatorLogic,
  porulleJobCoordinator,
} from "./coordinator.js";
export type {
  CoordinatorStorage,
  CoordinatorStub,
  CoordinatorWorkflowBinding,
  DurableObjectConcurrencyCoordinatorOptions,
  DurableObjectStateLike,
  PorulleJobCoordinatorEnv,
} from "./coordinator.js";
