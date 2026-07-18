import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import type {
  EnqueueOptions,
  ExecutionEngine,
  ExecutionEngineSetup,
  TaskDefinition,
} from "@porulle/core";

interface PgBossJobData {
  taskSlug: string;
  input: Record<string, unknown>;
  organizationId: string;
  queue: string;
  maxAttempts: number;
  concurrencyKey?: string;
}

interface PgBossJob {
  id: string;
  data: PgBossJobData;
  retryCount: number;
  retryLimit: number;
}

interface PgBossClient {
  start(): Promise<unknown>;
  stop(options?: { graceful?: boolean; timeout?: number }): Promise<unknown>;
  createQueue(name: string, options: { policy: "singleton" }): Promise<unknown>;
  send(
    name: string,
    data: PgBossJobData,
    options: Record<string, unknown>,
  ): Promise<string | null>;
  upsert(
    name: string,
    data: PgBossJobData,
    options: Record<string, unknown>,
  ): Promise<{ jobs: string[] }>;
  work(
    name: string,
    options: {
      includeMetadata: true;
      localConcurrency: number;
    },
    handler: (jobs: PgBossJob[]) => Promise<unknown>,
  ): Promise<string>;
}

export interface PgBossExecutionEngineOptions {
  connectionString?: string;
  client?: PgBossClient;
  queuePrefix?: string;
  localConcurrency?: number;
}

export class PgBossExecutionEngine implements ExecutionEngine {
  readonly execution = { mode: "push" as const };

  private readonly boss: PgBossClient;
  private readonly queueName: string;
  private readonly localConcurrency: number;
  private worker: Promise<void> | undefined;
  private started: Promise<void> | undefined;
  private setup: ExecutionEngineSetup | undefined;

  constructor(options: PgBossExecutionEngineOptions) {
    if (!options.client && !options.connectionString) {
      throw new Error(
        "PgBossExecutionEngine requires connectionString or an injected client.",
      );
    }
    if (options.client) {
      this.boss = options.client;
    } else {
      const boss = new PgBoss(options.connectionString!);
      this.boss = {
        start: () => boss.start(),
        stop: (stopOptions) => boss.stop(stopOptions),
        createQueue: (name, queueOptions) =>
          boss.createQueue(name, queueOptions),
        send: (name, data, sendOptions) => boss.send(name, data, sendOptions),
        upsert: (name, data, sendOptions) =>
          boss.upsert(name, data, sendOptions),
        work: (name, workOptions, handler) =>
          boss.work<PgBossJobData, unknown, typeof workOptions>(
            name,
            workOptions,
            handler,
          ),
      };
    }
    this.queueName = `${options.queuePrefix ?? "porulle"}-jobs`;
    this.localConcurrency = options.localConcurrency ?? 10;
  }

  register(setup: ExecutionEngineSetup): void {
    this.setup = setup;
  }

  async start(): Promise<void> {
    await this.ensureWorker();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true });
    this.started = undefined;
    this.worker = undefined;
  }

  async enqueue(
    taskSlug: string,
    input: Record<string, unknown>,
    options: EnqueueOptions,
  ): Promise<string> {
    const setup = this.requireSetup();
    const task = setup.tasks.get(taskSlug);
    if (!task) {
      throw new Error(`Unknown task slug: ${taskSlug}`);
    }

    const organizationId = options.organizationId.trim();
    if (!organizationId) {
      throw new Error("Jobs enqueue requires a non-empty organizationId.");
    }

    await this.ensureWorker();
    const concurrencyKey =
      options.concurrencyKey ?? task.concurrency?.key(input);
    const exclusive = Boolean(
      task.concurrency && task.concurrency.exclusive !== false,
    );
    const supersedes = options.supersedes ?? task.concurrency?.supersedes;
    const singletonKey =
      (exclusive || supersedes) && concurrencyKey
        ? concurrencyKey
        : randomUUID();
    const maxAttempts = options.maxAttempts ?? task.retries?.attempts ?? 1;
    const data: PgBossJobData = {
      taskSlug,
      input,
      organizationId,
      queue: options.queue ?? "default",
      maxAttempts,
      ...(concurrencyKey ? { concurrencyKey } : {}),
    };
    const sendOptions = this.translateSendOptions(
      task,
      options,
      maxAttempts,
      singletonKey,
    );
    if (supersedes && concurrencyKey) {
      const result = await this.boss.upsert(this.queueName, data, sendOptions);
      const id = result.jobs[0];
      if (!id) throw new Error("pg-boss did not return an upserted job id.");
      return id;
    }

    const id = randomUUID();
    const created = await this.boss.send(this.queueName, data, {
      ...sendOptions,
      id,
    });
    if (!created) throw new Error("pg-boss did not create the job.");
    return created;
  }

  private requireSetup(): ExecutionEngineSetup {
    if (!this.setup) {
      throw new Error("PgBossExecutionEngine must be registered before use.");
    }
    return this.setup;
  }

  private ensureStarted(): Promise<void> {
    this.started ??= this.boss
      .start()
      .then(() => undefined)
      .catch((error) => {
        this.started = undefined;
        throw error;
      });
    return this.started;
  }

  private ensureWorker(): Promise<void> {
    this.worker ??= this.startWorker().catch((error) => {
      this.worker = undefined;
      throw error;
    });
    return this.worker;
  }

  private async startWorker(): Promise<void> {
    await this.ensureStarted();
    await this.boss.createQueue(this.queueName, { policy: "singleton" });
    await this.boss.work(
      this.queueName,
      { includeMetadata: true, localConcurrency: this.localConcurrency },
      async (jobs) => Promise.all(jobs.map((job) => this.runJob(job))),
    );
  }

  private async runJob(job: PgBossJob): Promise<Record<string, unknown>> {
    const setup = this.requireSetup();
    const task = setup.tasks.get(job.data.taskSlug);
    if (!task) throw new Error(`Unknown task slug: ${job.data.taskSlug}`);

    const result = await task.handler({
      input: job.data.input,
      ctx: setup.context,
      job: {
        attemptNumber: job.retryCount + 1,
        maxAttempts: job.retryLimit + 1,
      },
    });
    return result.output;
  }

  private translateSendOptions(
    task: TaskDefinition,
    options: EnqueueOptions,
    maxAttempts: number,
    singletonKey: string,
  ): Record<string, unknown> {
    const backoff = task.retries?.backoff;
    return {
      singletonKey,
      retryLimit: Math.max(maxAttempts - 1, 0),
      ...(backoff
        ? {
            retryDelay: Math.max(1, Math.ceil(backoff.delay / 1000)),
            retryBackoff: backoff.type === "exponential",
          }
        : {}),
      ...(options.delayMs !== undefined
        ? { startAfter: new Date(Date.now() + options.delayMs) }
        : {}),
    };
  }
}
