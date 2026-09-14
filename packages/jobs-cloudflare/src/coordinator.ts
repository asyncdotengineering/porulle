import type {
  CloudflareConcurrencyCoordinator,
  CloudflareJobPayload,
  WorkflowBinding,
  WorkflowStep,
} from "./index.js";
import { hashJobInput } from "./index.js";

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
  /** Hash of `payload.input` for each pending instance — pruned whenever the id leaves `pending`. */
  pendingHashes: Record<string, string>;
}

/**
 * Pure per-key lock state machine behind `PorulleJobCoordinator`, kept free of
 * any `cloudflare:workers` dependency so it is directly unit-testable in Node
 * with an in-memory `CoordinatorStorage` and a fake `isStale` check.
 */
export class JobCoordinatorLogic {
  constructor(private readonly storage: CoordinatorStorage) {}

  /** First enqueue phase: storage only. Registers `instanceId` as pending for `key` before the
   * caller creates it, so a later supersede can see it even if it has not started running yet;
   * under `supersedes` the previously pending ids are cleared and returned for the caller to
   * terminate. Never touches the currently running instance — matching the drizzle adapter,
   * supersede only drops jobs that have not started. When a pending instance carries the same input its id
   * comes back as a CANDIDATE rather than a decision, so the Durable Object can check outside
   * the gate whether that instance still exists. */
  async enqueueRead(
    key: string,
    supersedes: boolean,
    instanceId: string,
    inputHash?: string,
  ): Promise<{ terminated: string[] } | { coalesceCandidate: string }> {
    const state = await this.getState(key);
    if (supersedes && inputHash !== undefined) {
      for (const pendingId of state.pending) {
        if (state.pendingHashes[pendingId] === inputHash) {
          return { coalesceCandidate: pendingId };
        }
      }
    }
    return this.commitEnqueue(key, supersedes, instanceId, inputHash, state);
  }

  /** Re-enter after the candidate was confirmed LIVE outside the gate. Coalesces only if the
   * candidate is STILL pending under the same hash — if it started running meanwhile it has
   * already read its input and the caller needs its own instance. */
  async enqueueAfterLiveCandidate(
    key: string,
    candidate: string,
    supersedes: boolean,
    instanceId: string,
    inputHash?: string,
  ): Promise<{ terminated: string[]; coalescedInto?: string }> {
    const state = await this.getState(key);
    if (
      supersedes &&
      inputHash !== undefined &&
      state.pending.includes(candidate) &&
      state.pendingHashes[candidate] === inputHash
    ) {
      return { terminated: [], coalescedInto: candidate };
    }
    return this.commitEnqueue(key, supersedes, instanceId, inputHash, state);
  }

  /** Re-enter after the candidate was found STALE outside the gate: enqueue normally, which
   * under `supersedes` drops every pending id including the dead candidate. */
  async enqueueAfterStaleCandidate(
    key: string,
    supersedes: boolean,
    instanceId: string,
    inputHash?: string,
  ): Promise<{ terminated: string[] }> {
    const state = await this.getState(key);
    return this.commitEnqueue(key, supersedes, instanceId, inputHash, state);
  }

  private async commitEnqueue(
    key: string,
    supersedes: boolean,
    instanceId: string,
    inputHash: string | undefined,
    state: CoordinatorKeyState,
  ): Promise<{ terminated: string[] }> {
    const terminated = supersedes ? state.pending.filter((id) => id !== instanceId) : [];
    const kept = supersedes ? [] : state.pending.filter((id) => id !== instanceId);
    const pendingHashes = { ...state.pendingHashes };
    for (const id of terminated) delete pendingHashes[id];
    if (inputHash !== undefined) pendingHashes[instanceId] = inputHash;
    await this.putState(key, {
      ...state,
      pending: [...kept, instanceId],
      pendingHashes,
    });
    return { terminated };
  }

  /** First gate phase: storage only. Returns `needsStaleCheck` when another instance
   * holds the key so the Durable Object can ask the Workflow binding outside the gate. */
  async acquireRead(
    key: string,
    instanceId: string,
  ): Promise<"granted" | { needsStaleCheck: string }> {
    const state = await this.getState(key);
    if (state.running === instanceId) return "granted";
    if (state.running === null) {
      await this.grantKey(key, instanceId, state);
      return "granted";
    }
    return { needsStaleCheck: state.running };
  }

  /** Re-enter after a live holder was confirmed outside the gate. */
  async acquireWhenHolderLive(
    key: string,
    instanceId: string,
  ): Promise<"granted" | "pending"> {
    const state = await this.getState(key);
    if (state.running === instanceId) return "granted";
    if (state.running === null) {
      await this.grantKey(key, instanceId, state);
      return "granted";
    }
    return this.enqueuePending(key, instanceId, state);
  }

  /** Re-enter after the holder was stale outside the gate — only grants when the
   * same id still holds the key, so a concurrent acquirer cannot be raced. */
  async acquireAfterStale(
    key: string,
    instanceId: string,
    checkedHolderId: string,
  ): Promise<"granted" | "pending"> {
    const state = await this.getState(key);
    if (state.running === instanceId) return "granted";
    if (state.running === checkedHolderId) {
      await this.grantKey(key, instanceId, state);
      return "granted";
    }
    return this.acquireWhenHolderLive(key, instanceId);
  }

  private async grantKey(
    key: string,
    instanceId: string,
    state: CoordinatorKeyState,
  ): Promise<void> {
    const pendingHashes = { ...state.pendingHashes };
    delete pendingHashes[instanceId];
    await this.putState(key, {
      pending: state.pending.filter((id) => id !== instanceId),
      running: instanceId,
      pendingHashes,
    });
  }

  private async enqueuePending(
    key: string,
    instanceId: string,
    state: CoordinatorKeyState,
  ): Promise<"pending"> {
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
    const pendingHashes = { ...state.pendingHashes };
    if (next) delete pendingHashes[next];
    await this.putState(key, { pending: rest, running: next ?? null, pendingHashes });
    return { next: next ?? null };
  }

  private async getState(key: string): Promise<CoordinatorKeyState> {
    const existing = await this.storage.get<CoordinatorKeyState>(this.storageKey(key));
    if (!existing) return { pending: [], running: null, pendingHashes: {} };
    // `pendingHashes` arrived after this object was already storing state in production, so a row
    // written by an earlier release has no such key. Backfilling on READ rather than migrating
    // keeps a coordinator from crashing on its own history — and a crash here takes every job on
    // that key with it.
    return { ...existing, pendingHashes: existing.pendingHashes ?? {} };
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
 * State mutations run under `blockConcurrencyWhile`; Workflow binding calls
 * (stale-holder checks and turn events) run outside it so a long release loop
 * cannot block every other RPC on the object. On `enqueue` with `supersedes`
 * the object reports the pending instances the caller must terminate. It needs
 * a `PORULLE_WORKFLOW` binding on its environment to detect dead lock holders
 * and to wake the next waiting instance.
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
      this.#logic = new JobCoordinatorLogic({
        get<T>(key: string) {
          return ctx.storage.get<T>(key);
        },
        put<T>(key: string, value: T) {
          return ctx.storage.put(key, value);
        },
      });
    }

    async #isStale(instanceId: string): Promise<boolean> {
      try {
        const handle = await this.#workflow.get(instanceId);
        const { status } = await handle.status();
        return STALE_INSTANCE_STATUSES.has(status);
      } catch {
        return true;
      }
    }

    async enqueue(
      key: string,
      supersedes: boolean,
      instanceId: string,
      inputHash?: string,
    ): Promise<{ terminated: string[]; coalescedInto?: string }> {
      const first = await this.#state.blockConcurrencyWhile(() =>
        this.#logic.enqueueRead(key, supersedes, instanceId, inputHash),
      );
      if (!("coalesceCandidate" in first)) return first;
      const stale = await this.#isStale(first.coalesceCandidate);
      return this.#state.blockConcurrencyWhile(() =>
        stale
          ? this.#logic.enqueueAfterStaleCandidate(key, supersedes, instanceId, inputHash)
          : this.#logic.enqueueAfterLiveCandidate(
              key,
              first.coalesceCandidate,
              supersedes,
              instanceId,
              inputHash,
            ),
      );
    }

    async acquire(key: string, instanceId: string): Promise<"granted" | "pending"> {
      const first = await this.#state.blockConcurrencyWhile(() =>
        this.#logic.acquireRead(key, instanceId),
      );
      if (first === "granted") return "granted";
      const stale = await this.#isStale(first.needsStaleCheck);
      return this.#state.blockConcurrencyWhile(() =>
        stale
          ? this.#logic.acquireAfterStale(key, instanceId, first.needsStaleCheck)
          : this.#logic.acquireWhenHolderLive(key, instanceId),
      );
    }

    /** Hands the key to the next pending instance that can still be woken; a
     * pending instance that died or was terminated meanwhile is skipped so the
     * key never ends up held by an instance that will never release it. */
    release(key: string, instanceId: string): Promise<void> {
      return this.#releaseAndWake(key, instanceId);
    }

    async #releaseAndWake(key: string, holder: string): Promise<void> {
      const { next } = await this.#state.blockConcurrencyWhile(() =>
        this.#logic.release(key, holder),
      );
      if (!next) return;
      const woken = await this.#workflow
        .get(next)
        .then((handle) => handle.sendEvent({ type: TURN_EVENT_TYPE }))
        .then(() => true, () => false);
      if (woken) return;
      return this.#releaseAndWake(key, next);
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
    inputHash?: string,
  ): Promise<{ terminated: string[]; coalescedInto?: string }>;
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
    const inputHash = hashJobInput(payload.input);
    const { terminated, coalescedInto } = await this.options
      .stub(key)
      .enqueue(key, payload.supersedes, payload.jobId, inputHash);
    if (coalescedInto) return { id: coalescedInto };
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
