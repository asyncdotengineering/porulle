import type {
  CloudflareConcurrencyCoordinator,
  CloudflareJobPayload,
  WorkflowBinding,
  WorkflowStep,
} from "./index.js";

const STALE_INSTANCE_STATUSES = new Set(["complete", "errored", "terminated"]);
const TURN_EVENT_TYPE = "porulle-turn";
const FIRST_TURN_WAIT_MS = 60_000;
const MAX_TURN_WAIT_MS = 3_600_000;
const COORDINATOR_STEP = {
  retries: { limit: 3, delay: 1_000, backoff: "exponential" as const },
};

/** Each wait round costs two Workflow steps against the instance's step budget,
 * so the timeout doubles per round from one minute up to one hour: a waiter
 * still recovers from a holder that died without releasing, and a day-long
 * queue costs tens of steps rather than thousands. */
function turnWaitMs(round: number): number {
  return Math.min(FIRST_TURN_WAIT_MS * 2 ** round, MAX_TURN_WAIT_MS);
}

function coordinatorKey(payload: CloudflareJobPayload): string {
  return `${payload.organizationId}:${payload.taskSlug}:${payload.concurrencyKey}`;
}

export interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface CoordinatorKeyState {
  pending: string[];
  running: string | null;
}

/**
 * Pure per-key lock state machine behind `PorulleJobCoordinator`, kept free of
 * any `cloudflare:workers` dependency so it is directly unit-testable in Node
 * with an in-memory `CoordinatorStorage` and a fake `isStale` check.
 */
export class JobCoordinatorLogic {
  constructor(
    private readonly storage: CoordinatorStorage,
    private readonly isStale: (instanceId: string) => Promise<boolean>,
  ) {}

  /** Registers `instanceId` as pending for `key` before the caller creates it, so
   * a later supersede can see it even if it has not started running yet. When
   * `supersedes` is set, the previously pending ids are cleared and returned for
   * the caller to terminate. Never touches the currently running instance —
   * matching the drizzle adapter, supersede only drops jobs that have not started. */
  async enqueue(
    key: string,
    supersedes: boolean,
    instanceId: string,
  ): Promise<{ terminated: string[] }> {
    const state = await this.getState(key);
    const terminated = supersedes ? state.pending.filter((id) => id !== instanceId) : [];
    const kept = supersedes ? [] : state.pending.filter((id) => id !== instanceId);
    await this.putState(key, { ...state, pending: [...kept, instanceId] });
    return { terminated };
  }

  async acquire(key: string, instanceId: string): Promise<"granted" | "pending"> {
    let state = await this.getState(key);
    if (state.running === instanceId) return "granted";
    if (state.running !== null && (await this.isStale(state.running))) {
      state = { ...state, running: null };
    }
    if (state.running === null) {
      await this.putState(key, {
        pending: state.pending.filter((id) => id !== instanceId),
        running: instanceId,
      });
      return "granted";
    }
    if (!state.pending.includes(instanceId)) {
      await this.putState(key, {
        ...state,
        pending: [...state.pending, instanceId],
      });
    }
    return "pending";
  }

  /** Releases the lock if `instanceId` holds it and hands it to the next
   * pending instance (if any), returning that instance's id so the caller can
   * wake it. A release from an instance that does not hold the lock is a no-op. */
  async release(key: string, instanceId: string): Promise<{ next: string | null }> {
    const state = await this.getState(key);
    if (state.running !== instanceId) return { next: null };
    const [next, ...rest] = state.pending;
    await this.putState(key, { pending: rest, running: next ?? null });
    return { next: next ?? null };
  }

  private async getState(key: string): Promise<CoordinatorKeyState> {
    const existing = await this.storage.get<CoordinatorKeyState>(this.storageKey(key));
    return existing ?? { pending: [], running: null };
  }

  private async putState(key: string, state: CoordinatorKeyState): Promise<void> {
    await this.storage.put(this.storageKey(key), state);
  }

  private storageKey(key: string): string {
    return `porulle-job-coordinator:${key}`;
  }
}

/** What the Durable Object needs from the Workflow binding — satisfied by
 * Cloudflare's raw binding and by an adapted `WorkflowBinding` alike. */
export interface CoordinatorWorkflowBinding {
  get(id: string): Promise<{
    status(): Promise<{ status: string }>;
    sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
  }>;
}

export interface PorulleJobCoordinatorEnv {
  PORULLE_WORKFLOW: CoordinatorWorkflowBinding;
}

/** The subset of the real `DurableObjectState` this coordinator touches. */
export interface DurableObjectStateLike {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

type DurableObjectConstructor = abstract new (...args: any[]) => object;

/**
 * Builds the coordinator Durable Object on the app's own `DurableObject` base
 * class. `cloudflare:workers` only resolves inside the Workers runtime, so the
 * Worker imports it and passes it in — this package stays importable under Node:
 *
 * ```ts
 * import { DurableObject } from "cloudflare:workers";
 * export class PorulleJobCoordinator extends porulleJobCoordinator(DurableObject) {}
 * ```
 *
 * Every RPC runs under `blockConcurrencyWhile`: the stale-holder check is a
 * Workflow subrequest, which would otherwise open the input gate between the
 * read and the write and let two acquirers both be granted. On `enqueue` with
 * `supersedes` the object reports the pending instances the caller must
 * terminate. It needs a `PORULLE_WORKFLOW` binding on its environment to detect
 * dead lock holders and to wake the next waiting instance.
 */
export function porulleJobCoordinator<TBase extends DurableObjectConstructor>(
  Base: TBase,
) {
  abstract class PorulleJobCoordinator extends Base {
    readonly #logic: JobCoordinatorLogic;
    readonly #workflow: CoordinatorWorkflowBinding;
    readonly #state: DurableObjectStateLike;

    constructor(...args: any[]) {
      super(...args);
      const [ctx, env] = args as [DurableObjectStateLike, PorulleJobCoordinatorEnv];
      this.#state = ctx;
      this.#workflow = env.PORULLE_WORKFLOW;
      this.#logic = new JobCoordinatorLogic(
        {
          get<T>(key: string) {
            return ctx.storage.get<T>(key);
          },
          put<T>(key: string, value: T) {
            return ctx.storage.put(key, value);
          },
        },
        async (instanceId) => {
          try {
            const handle = await env.PORULLE_WORKFLOW.get(instanceId);
            const { status } = await handle.status();
            return STALE_INSTANCE_STATUSES.has(status);
          } catch {
            return true;
          }
        },
      );
    }

    enqueue(
      key: string,
      supersedes: boolean,
      instanceId: string,
    ): Promise<{ terminated: string[] }> {
      return this.#state.blockConcurrencyWhile(() =>
        this.#logic.enqueue(key, supersedes, instanceId),
      );
    }

    acquire(key: string, instanceId: string): Promise<"granted" | "pending"> {
      return this.#state.blockConcurrencyWhile(() =>
        this.#logic.acquire(key, instanceId),
      );
    }

    /** Hands the key to the next pending instance that can still be woken; a
     * pending instance that died or was terminated meanwhile is skipped so the
     * key never ends up held by an instance that will never release it. */
    release(key: string, instanceId: string): Promise<void> {
      return this.#state.blockConcurrencyWhile(async () => {
        let holder = instanceId;
        for (;;) {
          const { next } = await this.#logic.release(key, holder);
          if (!next) return;
          const woken = await this.#workflow
            .get(next)
            .then((handle) => handle.sendEvent({ type: TURN_EVENT_TYPE }))
            .then(() => true, () => false);
          if (woken) return;
          holder = next;
        }
      });
    }
  }
  return PorulleJobCoordinator;
}

/** The RPC surface `DurableObjectConcurrencyCoordinator` calls on a
 * `PorulleJobCoordinator` stub — the subset of `DurableObjectStub<PorulleJobCoordinator>`
 * this package needs, so callers can inject a fake in tests without the Workers runtime. */
export interface CoordinatorStub {
  enqueue(
    key: string,
    supersedes: boolean,
    instanceId: string,
  ): Promise<{ terminated: string[] }>;
  acquire(key: string, instanceId: string): Promise<"granted" | "pending">;
  release(key: string, instanceId: string): Promise<void>;
}

export interface DurableObjectConcurrencyCoordinatorOptions {
  /** Resolves the Durable Object for a coordination key
   * (`organizationId:taskSlug:concurrencyKey`); return one object per key so
   * keys never queue behind each other. */
  stub: (key: string) => CoordinatorStub;
  workflow: WorkflowBinding;
}

/** `CloudflareConcurrencyCoordinator` backed by a `PorulleJobCoordinator` Durable
 * Object: supersede terminates pending instances at enqueue, and `run` serialises
 * same-key instances through the DO's `acquire`/`release`, waiting with
 * `step.waitForEvent` when another instance already holds the key. */
export class DurableObjectConcurrencyCoordinator
  implements CloudflareConcurrencyCoordinator
{
  constructor(private readonly options: DurableObjectConcurrencyCoordinatorOptions) {}

  async enqueue(
    payload: CloudflareJobPayload,
    create: () => Promise<{ id: string }>,
  ): Promise<{ id: string }> {
    if (!payload.concurrencyKey) return create();
    const key = coordinatorKey(payload);
    const { terminated } = await this.options
      .stub(key)
      .enqueue(key, payload.supersedes, payload.jobId);
    await Promise.all(
      terminated.map((id) =>
        this.options.workflow
          .get(id)
          .then((handle) => handle.terminate())
          .catch(() => undefined),
      ),
    );
    return create();
  }

  /** Every coordinator call is its own Workflow step, so a replay of the body
   * neither re-acquires nor re-releases. A parked instance wakes on the turn
   * event or, at the latest, after `turnWaitMs(round)`, and re-acquires — which
   * is how waiters recover when the holder was terminated without releasing. A
   * release that fails after its retries is dropped rather than masking the
   * handler's outcome: the next acquirer sees the finished holder as stale. */
  async run<T>(
    payload: CloudflareJobPayload,
    step: WorkflowStep,
    handler: () => Promise<T>,
  ): Promise<T> {
    if (!payload.concurrencyKey) return handler();
    const key = coordinatorKey(payload);
    const stub = this.options.stub(key);
    for (let round = 0; ; round += 1) {
      const turn = await step.do(
        `porulle-turn:acquire:${round}`,
        COORDINATOR_STEP,
        () => stub.acquire(key, payload.jobId),
      );
      if (turn === "granted") break;
      await step
        .waitForEvent(`porulle-turn:wait:${round}`, {
          type: TURN_EVENT_TYPE,
          timeout: turnWaitMs(round),
        })
        .catch(() => undefined);
    }
    try {
      return await handler();
    } finally {
      await step
        .do("porulle-turn:release", COORDINATOR_STEP, () =>
          stub.release(key, payload.jobId),
        )
        .catch(() => undefined);
    }
  }
}
