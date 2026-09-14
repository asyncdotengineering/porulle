import { describe, expect, it, vi } from "vitest";
import type { CloudflareJobPayload, WorkflowBinding, WorkflowStep } from "../src/index.js";
import {
  DurableObjectConcurrencyCoordinator,
  JobCoordinatorLogic,
  porulleJobCoordinator,
  type CoordinatorStub,
  type CoordinatorStorage,
  type DurableObjectStateLike,
  type PorulleJobCoordinatorEnv,
} from "../src/coordinator.js";

function createMemoryStorage(): CoordinatorStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      store.set(key, value);
    },
  };
}

/** Mirrors the Durable Object's acquire path so logic tests can inject a fake `isStale`. */
async function acquireWithStaleCheck(
  logic: JobCoordinatorLogic,
  key: string,
  instanceId: string,
  isStale: (instanceId: string) => Promise<boolean>,
): Promise<"granted" | "pending"> {
  const first = await logic.acquireRead(key, instanceId);
  if (first === "granted") return "granted";
  const stale = await isStale(first.needsStaleCheck);
  return stale
    ? logic.acquireAfterStale(key, instanceId, first.needsStaleCheck)
    : logic.acquireWhenHolderLive(key, instanceId);
}

/** Mirrors the Durable Object's enqueue path so logic tests can inject a fake `isStale`. */
async function enqueueWithStaleCheck(
  logic: JobCoordinatorLogic,
  key: string,
  supersedes: boolean,
  instanceId: string,
  inputHash: string | undefined,
  isStale: (instanceId: string) => Promise<boolean>,
): Promise<{ terminated: string[]; coalescedInto?: string }> {
  const first = await logic.enqueueRead(key, supersedes, instanceId, inputHash);
  if (!("coalesceCandidate" in first)) return first;
  const stale = await isStale(first.coalesceCandidate);
  return stale
    ? logic.enqueueAfterStaleCandidate(key, supersedes, instanceId, inputHash)
    : logic.enqueueAfterLiveCandidate(
        key,
        first.coalesceCandidate,
        supersedes,
        instanceId,
        inputHash,
      );
}

function payloadFor(overrides: Partial<CloudflareJobPayload> = {}): CloudflareJobPayload {
  return {
    jobId: "instance-1",
    taskSlug: "catalog/import",
    input: {},
    organizationId: "org-1",
    maxAttempts: 1,
    exclusive: true,
    supersedes: true,
    concurrencyKey: "store-1",
    ...overrides,
  };
}

describe("JobCoordinatorLogic", () => {
  const alive = async () => false;

  it("grants the lock immediately when the key is free", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    await expect(acquireWithStaleCheck(logic, "key", "a", async () => false)).resolves.toBe("granted");
  });

  it("queues a second instance and hands it the lock on release", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    await expect(acquireWithStaleCheck(logic, "key", "a", async () => false)).resolves.toBe("granted");
    await expect(acquireWithStaleCheck(logic, "key", "b", async () => false)).resolves.toBe("pending");

    await expect(logic.release("key", "a")).resolves.toEqual({ next: "b" });
    // "b" now holds the lock — a second release call for "a" (which no longer
    // holds it) must be a no-op, proving release doesn't hand out the lock twice.
    await expect(logic.release("key", "a")).resolves.toEqual({ next: null });
    await expect(logic.release("key", "b")).resolves.toEqual({ next: null });
  });

  it("treats a stale running instance as free and grants the new one", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    const isStale = async (id: string) => id === "a";
    await expect(acquireWithStaleCheck(logic, "key", "a", isStale)).resolves.toBe("granted");
    await expect(acquireWithStaleCheck(logic, "key", "b", isStale)).resolves.toBe("granted");
  });

  it("drops a waiter from the pending queue when it re-acquires a key whose holder died", async () => {
    let holderDead = false;
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    const isStale = async (id: string) => id === "a" && holderDead;
    await acquireWithStaleCheck(logic, "key", "a", isStale);
    await expect(acquireWithStaleCheck(logic, "key", "b", isStale)).resolves.toBe("pending");
    holderDead = true;
    await expect(acquireWithStaleCheck(logic, "key", "b", isStale)).resolves.toBe("granted");
    await expect(logic.release("key", "b")).resolves.toEqual({ next: null });
  });

  it("enqueue with supersedes clears and returns the pending queue and registers the new instance", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    const acquire = (id: string) => acquireWithStaleCheck(logic, "key", id, async () => false);
    await acquire("running");
    await acquire("pending-1");
    await acquire("pending-2");

    await expect(enqueueWithStaleCheck(logic, "key", true, "new", undefined, alive)).resolves.toEqual({
      terminated: ["pending-1", "pending-2"],
    });
    // The running instance was never touched by supersede; "new" is next in line.
    await expect(acquire("running")).resolves.toBe("granted");
    await expect(logic.release("key", "running")).resolves.toEqual({ next: "new" });
  });

  /**
   * Durable Object storage written BEFORE `pendingHashes` existed is still out there: the deployed
   * Worker's coordinators hold rows from every sweep before this release, and a key whose holder was
   * terminated without releasing leaves a non-empty `pending` behind. Reading one of those must not
   * throw — a coordinator that crashes on its own history takes every job on that key with it, and
   * no suite that starts from empty storage can see it.
   */
  it("reads state written before pendingHashes existed without throwing", async () => {
    const storage = createMemoryStorage();
    // Exactly the shape the previous release persisted: no `pendingHashes` key at all.
    await storage.put("porulle-job-coordinator:key", { pending: ["old-1"], running: null });
    const logic = new JobCoordinatorLogic(storage);

    await expect(enqueueWithStaleCheck(logic, "key", true, "new-1", "hash-a", alive)).resolves.toEqual({
      terminated: ["old-1"],
    });
    await expect(acquireWithStaleCheck(logic, "key", "new-1", async () => false)).resolves.toBe("granted");
  });

  it("enqueue without supersedes appends to the queue", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    const acquire = (id: string) => acquireWithStaleCheck(logic, "key", id, async () => false);
    await acquire("running");
    await acquire("pending-1");

    await expect(enqueueWithStaleCheck(logic, "key", false, "new", undefined, alive)).resolves.toEqual({ terminated: [] });
    await expect(logic.release("key", "running")).resolves.toEqual({ next: "pending-1" });
    await expect(logic.release("key", "pending-1")).resolves.toEqual({ next: "new" });
  });

  // --- Coalescing a superseding enqueue BEFORE a Workflow instance exists -------------------
  //
  // Today `enqueue` takes the turn and the CALLER then creates an instance regardless, so N
  // superseding enqueues on one key produce N instances and N-1 terminations to run one job.
  // Measured on the deployed Worker on 2026-09-14 during one gflock-100 sweep: 26 Terminated
  // against 22 Completed in the latest 50 instances, and one coordinator Durable Object reset
  // with "A call to blockConcurrencyWhile() waited for too long" after a product's ~13
  // variant-level enqueues piled onto it.
  //
  // The fix coalesces on INPUT EQUALITY rather than by mutating a pending instance, because
  // Cloudflare Workflow params are fixed at creation — `WorkflowBinding` is create/get and the
  // handle has status/terminate/sendEvent and no update. Identical input means an identical job,
  // so reusing the pending instance is a true no-op; a DIFFERENT input must keep today's
  // latest-wins behaviour, or supersede silently inverts to oldest-wins.

  it("coalesces a superseding enqueue into the pending instance when the input is identical", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    const same = "hash-entity-a";
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-1", same, alive)).resolves.toEqual({ terminated: [] });
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-2", same, alive)).resolves.toEqual({
      terminated: [],
      coalescedInto: "gen-1",
    });
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-3", same, alive)).resolves.toEqual({
      terminated: [],
      coalescedInto: "gen-1",
    });
    // Only the ORIGINAL is pending; gen-2 and gen-3 never became instances, so neither may be
    // parked in the queue waiting for a turn that will never be taken.
    await expect(acquireWithStaleCheck(logic, "key", "gen-1", async () => false)).resolves.toBe("granted");
    await expect(logic.release("key", "gen-1")).resolves.toEqual({ next: null });
  });

  it("does NOT coalesce when the input differs — supersede stays latest-wins", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-1", "hash-a", alive)).resolves.toEqual({ terminated: [] });
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-2", "hash-b", alive)).resolves.toEqual({
      terminated: ["gen-1"],
    });
    await expect(acquireWithStaleCheck(logic, "key", "gen-2", async () => false)).resolves.toBe("granted");
  });

  it("never coalesces into a RUNNING instance — it has already read its input", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    const same = "hash-entity-a";
    await enqueueWithStaleCheck(logic, "key", true, "running", same, alive);
    await expect(acquireWithStaleCheck(logic, "key", "running", async () => false)).resolves.toBe("granted");
    // The running instance read `same` before the new state existed, so a new enqueue carrying the
    // same input must still become its own instance and queue behind it.
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-2", same, alive)).resolves.toEqual({ terminated: [] });
    await expect(logic.release("key", "running")).resolves.toEqual({ next: "gen-2" });
  });

  it("coalesces per key — an identical input under a different key is its own instance", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    const same = "hash-entity-a";
    await enqueueWithStaleCheck(logic, "key-a", true, "gen-1", same, alive);
    await expect(enqueueWithStaleCheck(logic, "key-b", true, "gen-2", same, alive)).resolves.toEqual({ terminated: [] });
    await expect(acquireWithStaleCheck(logic, "key-a", "gen-1", async () => false)).resolves.toBe("granted");
    await expect(acquireWithStaleCheck(logic, "key-b", "gen-2", async () => false)).resolves.toBe("granted");
  });

  it("supersede terminates an instance that was enqueued but has not started running yet", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage());
    await enqueueWithStaleCheck(logic, "key", true, "gen-1", undefined, alive);
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-2", undefined, alive)).resolves.toEqual({ terminated: ["gen-1"] });
    await expect(enqueueWithStaleCheck(logic, "key", true, "gen-3", undefined, alive)).resolves.toEqual({ terminated: ["gen-2"] });
    // Only the survivor can take the key; it is dropped from pending as it does.
    await expect(acquireWithStaleCheck(logic, "key", "gen-3", async () => false)).resolves.toBe("granted");
    await expect(logic.release("key", "gen-3")).resolves.toEqual({ next: null });
  });
});

function createWorkflowMock() {
  const handle = {
    status: vi.fn(async () => ({ status: "terminated" as const })),
    terminate: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
  };
  const workflow: WorkflowBinding = {
    create: vi.fn(),
    get: vi.fn(async () => handle),
  };
  return { workflow, handle };
}

function createStepMock(): WorkflowStep {
  const step: WorkflowStep = {
    async sleep() {},
    async do(_name, _config, callback) {
      return callback({ attempt: 1 });
    },
    async waitForEvent() {},
  };
  vi.spyOn(step, "sleep");
  vi.spyOn(step, "do");
  vi.spyOn(step, "waitForEvent");
  return step;
}

describe("DurableObjectConcurrencyCoordinator", () => {
  it("terminates every id the stub reports as superseded before creating the new instance", async () => {
    const { workflow, handle } = createWorkflowMock();
    const stub: CoordinatorStub = {
      enqueue: vi.fn(async () => ({ terminated: ["old-1", "old-2"] })),
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const stubFor = vi.fn(() => stub);
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: stubFor, workflow });
    const create = vi.fn(async () => ({ id: "new-1" }));

    await expect(coordinator.enqueue(payloadFor(), create)).resolves.toEqual({ id: "new-1" });
    expect(stubFor).toHaveBeenCalledWith("org-1:catalog/import:store-1");
    expect(stub.enqueue).toHaveBeenCalledWith("org-1:catalog/import:store-1", true, "instance-1", expect.any(String));
    expect(workflow.get).toHaveBeenCalledWith("old-1");
    expect(workflow.get).toHaveBeenCalledWith("old-2");
    expect(handle.terminate).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it("skips create() and returns the existing instance when the stub coalesces", async () => {
    const { workflow, handle } = createWorkflowMock();
    const stub: CoordinatorStub = {
      enqueue: vi.fn(async () => ({ terminated: [], coalescedInto: "already-pending" })),
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: () => stub, workflow });
    const create = vi.fn(async () => ({ id: "new-1" }));

    await expect(coordinator.enqueue(payloadFor(), create)).resolves.toEqual({ id: "already-pending" });
    // The whole point: no instance is created, so nothing has to be terminated either.
    expect(create).not.toHaveBeenCalled();
    expect(handle.terminate).not.toHaveBeenCalled();
  });

  it("passes a stable input hash to the stub so the DO can decide equality without the payload", async () => {
    const { workflow } = createWorkflowMock();
    const stub: CoordinatorStub = {
      enqueue: vi.fn(async () => ({ terminated: [] })),
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: () => stub, workflow });
    const create = vi.fn(async () => ({ id: "new-1" }));

    await coordinator.enqueue(payloadFor({ jobId: "a", input: { entityId: "e1", organizationId: "o1" } }), create);
    await coordinator.enqueue(payloadFor({ jobId: "b", input: { organizationId: "o1", entityId: "e1" } }), create);
    const hashes = (stub.enqueue as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[3]);
    expect(hashes[0]).toBeTypeOf("string");
    expect(hashes[0]).not.toHaveLength(0);
    // Key ORDER must not change the hash, or two identical enqueues coalesce only by luck.
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("runs immediately without waiting when the stub grants the lock", async () => {
    const { workflow } = createWorkflowMock();
    const stub: CoordinatorStub = {
      enqueue: vi.fn(),
      acquire: vi.fn(async () => "granted" as const),
      release: vi.fn(async () => undefined),
    };
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: () => stub, workflow });
    const step = createStepMock();
    const handler = vi.fn(async () => "done");

    await expect(coordinator.run(payloadFor(), step, handler)).resolves.toBe("done");
    expect(step.waitForEvent).not.toHaveBeenCalled();
    expect(step.do).toHaveBeenCalledWith("porulle-turn:acquire:0", expect.anything(), expect.any(Function));
    expect(step.do).toHaveBeenCalledWith("porulle-turn:release", expect.anything(), expect.any(Function));
    expect(stub.release).toHaveBeenCalledWith("org-1:catalog/import:store-1", "instance-1");
  });

  it("waits for the turn event when the lock is not granted, and always releases", async () => {
    const { workflow } = createWorkflowMock();
    const turns: Array<"granted" | "pending"> = ["pending", "granted"];
    const stub: CoordinatorStub = {
      enqueue: vi.fn(),
      acquire: vi.fn(async () => turns.shift()!),
      release: vi.fn(async () => undefined),
    };
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: () => stub, workflow });
    const step = createStepMock();
    const handler = vi.fn(async () => {
      throw new Error("handler failed");
    });

    await expect(coordinator.run(payloadFor(), step, handler)).rejects.toThrow(
      "handler failed",
    );
    expect(step.waitForEvent).toHaveBeenCalledWith("porulle-turn:wait:0", {
      type: "porulle-turn",
      timeout: 60_000,
    });
    expect(stub.acquire).toHaveBeenCalledTimes(2);
    expect(stub.release).toHaveBeenCalledWith("org-1:catalog/import:store-1", "instance-1");
  });

  it("re-acquires after a wait timeout instead of failing the instance", async () => {
    const { workflow } = createWorkflowMock();
    const turns: Array<"granted" | "pending"> = ["pending", "pending", "granted"];
    const stub: CoordinatorStub = {
      enqueue: vi.fn(),
      acquire: vi.fn(async () => turns.shift()!),
      release: vi.fn(async () => undefined),
    };
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: () => stub, workflow });
    const step = createStepMock();
    vi.mocked(step.waitForEvent).mockRejectedValue(new Error("Timed out"));
    const handler = vi.fn(async () => "ran");

    await expect(coordinator.run(payloadFor(), step, handler)).resolves.toBe("ran");
    expect(step.waitForEvent).toHaveBeenCalledTimes(2);
    expect(step.waitForEvent).toHaveBeenLastCalledWith("porulle-turn:wait:1", {
      type: "porulle-turn",
      timeout: 120_000,
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not let a failing release mask the handler's outcome", async () => {
    const { workflow } = createWorkflowMock();
    const stub: CoordinatorStub = {
      enqueue: vi.fn(),
      acquire: vi.fn(async () => "granted" as const),
      release: vi.fn(async () => {
        throw new Error("durable object unavailable");
      }),
    };
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: () => stub, workflow });
    const step = createStepMock();

    await expect(coordinator.run(payloadFor(), step, async () => "ran")).resolves.toBe("ran");
    await expect(
      coordinator.run(payloadFor(), step, async () => {
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");
  });
});

describe("porulleJobCoordinator", () => {
  class FakeDurableObject {
    constructor(
      readonly ctx: DurableObjectStateLike,
      readonly env: PorulleJobCoordinatorEnv,
    ) {}
  }

  function createDurableObject(
    handles: Record<string, { status: string; sendEventFails?: boolean; unknown?: boolean }>,
  ) {
    const store = new Map<string, unknown>();
    const sent: string[] = [];
    // Every Workflow-binding call made while blockConcurrencyWhile is held is recorded here. The
    // gate exists to serialise STATE; network I/O under it blocks every other RPC on the object.
    const workflowCallsInsideGate: string[] = [];
    let insideGate = false;
    const workflow: WorkflowBinding = {
      create: vi.fn(),
      async get(id) {
        if (insideGate) workflowCallsInsideGate.push(`get:${id}`);
        const entry = handles[id] ?? { status: "running" };
        if (entry.unknown) throw new Error(`instance ${id} does not exist`);
        return {
          status: async () => ({ status: entry.status as "running" }),
          terminate: async () => undefined,
          sendEvent: async () => {
            if (insideGate) workflowCallsInsideGate.push(`sendEvent:${id}`);
            if (entry.sendEventFails) throw new Error(`instance ${id} is not waiting`);
            sent.push(id);
          },
        };
      },
    };
    class Coordinator extends porulleJobCoordinator(FakeDurableObject) {}
    let gate: Promise<unknown> = Promise.resolve();
    const object = new Coordinator(
      {
        storage: {
          async get<T>(key: string) {
            return store.get(key) as T | undefined;
          },
          async put<T>(key: string, value: T) {
            store.set(key, value);
          },
        },
        blockConcurrencyWhile<T>(callback: () => Promise<T>) {
          const guarded = async () => {
            insideGate = true;
            try {
              return await callback();
            } finally {
              insideGate = false;
            }
          };
          const run = gate.then(guarded, guarded);
          gate = run.catch(() => undefined);
          return run;
        },
      },
      { PORULLE_WORKFLOW: workflow },
    );
    return { object, sent, workflowCallsInsideGate };
  }

  /**
   * Input-equality coalescing arrived in 0.31.0 and made `pending` load-bearing without ever
   * checking that a pending instance still exists. Nothing removes a pending id when its instance
   * is terminated: `grantKey` needs it to acquire, `release` needs it to be next in line, and a
   * supersede only drops it when the input DIFFERS. So ONE instance terminated through the API
   * before it took a turn absorbs every later enqueue carrying the same input, for that key,
   * forever — and the caller is told the enqueue succeeded.
   *
   * Measured on the deployed merchant-center Worker on 2026-09-15: instance `873c595c` was
   * terminated at 01:02 IST before it acquired, and every `POST /api/loom/projection/backfill`
   * afterwards answered 202 and created no Workflow instance at all. Before 0.31.0 the same
   * enqueue superseded — it terminated the pending id and created a new instance — so a dead
   * pending id could not block a key.
   */
  it("does not coalesce into a pending instance that no longer exists", async () => {
    const { object } = createDurableObject({ ghost: { status: "terminated" } });
    const same = "hash-entity-a";
    await expect(object.enqueue("key", true, "ghost", same)).resolves.toEqual({ terminated: [] });
    await expect(object.enqueue("key", true, "fresh", same)).resolves.toEqual({
      terminated: ["ghost"],
    });
    // And the instance the caller then creates can actually take the key, rather than queueing
    // behind the corpse it just displaced.
    await expect(object.acquire("key", "fresh")).resolves.toBe("granted");
  });

  /** The sibling of the row above: the fix must not buy liveness by dropping coalescing, which is
   * the whole reason 0.31.0 exists (1,303 enqueues for 104 distinct projections). A pending
   * instance that is still alive absorbs an identical enqueue exactly as before. */
  it("still coalesces into a pending instance that is alive", async () => {
    const { object } = createDurableObject({});
    const same = "hash-entity-a";
    await expect(object.enqueue("key", true, "gen-1", same)).resolves.toEqual({ terminated: [] });
    await expect(object.enqueue("key", true, "gen-2", same)).resolves.toEqual({
      terminated: [],
      coalescedInto: "gen-1",
    });
  });

  /** Same rule the holder stale-check already follows: the Workflow binding is network I/O and the
   * gate serialises state. A liveness check inside `blockConcurrencyWhile` would block every other
   * RPC on the object behind a round trip — the failure that reset a coordinator with "A call to
   * blockConcurrencyWhile() waited for too long". */
  it("checks a coalesce candidate's liveness outside the concurrency gate", async () => {
    const { object, workflowCallsInsideGate } = createDurableObject({ ghost: { status: "terminated" } });
    await object.enqueue("key", true, "ghost", "hash-a");
    await object.enqueue("key", true, "fresh", "hash-a");
    expect(workflowCallsInsideGate).toEqual([]);
  });

  it("extends the supplied base class and wakes the next pending instance on release", async () => {
    const { object, sent } = createDurableObject({});
    expect(object).toBeInstanceOf(FakeDurableObject);
    await expect(object.acquire("key", "a")).resolves.toBe("granted");
    await expect(object.acquire("key", "b")).resolves.toBe("pending");

    await object.release("key", "a");
    expect(sent).toEqual(["b"]);
    // "b" holds the key now: a fresh acquire from "b" is granted without queueing.
    await expect(object.acquire("key", "b")).resolves.toBe("granted");
  });

  /**
   * The Durable Object reset measured on the deployed Worker on 2026-09-14 — instance 9809aac0,
   * `porulle-turn:acquire:0-1` held 33 seconds, "A call to blockConcurrencyWhile() in a Durable
   * Object waited for too long. The call was canceled and the Durable Object was reset."
   *
   * `acquire` does one storage read and one write; it cannot take 33 s on its own. It was queued
   * behind `release`, which loops `workflow.get(next)` then `sendEvent(...)` — two binding round
   * trips per iteration, over as many dead pending ids as a supersede storm left behind — entirely
   * INSIDE the gate. The gate is there to serialise state. Waking is not state.
   *
   * Compute the next holder inside; wake outside.
   */
  it("never touches the Workflow binding while the concurrency gate is held", async () => {
    // Two waiters, the first of which can no longer be woken, so release must consider both —
    // one round of the loop would not discriminate.
    const { object, sent, workflowCallsInsideGate } = createDurableObject({
      b: { status: "terminated", sendEventFails: true },
    });
    await object.acquire("key", "a");
    await object.acquire("key", "b");
    await object.acquire("key", "c");

    await object.release("key", "a");

    expect(
      workflowCallsInsideGate,
      "release must compute the next holder inside blockConcurrencyWhile and wake it OUTSIDE — a "
        + "loop of Workflow round trips under the gate is what resets the Durable Object under load",
    ).toEqual([]);
    // And it still does its job: the unwakeable waiter is skipped and the key reaches the next one.
    expect(sent, "the key must still reach the first waiter that can be woken").toEqual(["c"]);
    await expect(object.acquire("key", "c")).resolves.toBe("granted");
  });

  it("skips a pending instance that can no longer be woken and hands the key to the one after it", async () => {
    const { object, sent } = createDurableObject({ b: { status: "terminated", sendEventFails: true } });
    await object.acquire("key", "a");
    await object.acquire("key", "b");
    await object.acquire("key", "c");

    await object.release("key", "a");
    expect(sent).toEqual(["c"]);
    await expect(object.acquire("key", "c")).resolves.toBe("granted");
    // Nobody is left waiting: a release from "c" wakes no one and frees the key.
    await object.release("key", "c");
    await expect(object.acquire("key", "d")).resolves.toBe("granted");
  });

  it("grants only one of two concurrent acquirers that both find a dead holder", async () => {
    const { object } = createDurableObject({ dead: { status: "terminated" } });
    await object.acquire("key", "dead");
    const results = await Promise.all([object.acquire("key", "a"), object.acquire("key", "b")]);
    expect(results.filter((result) => result === "granted")).toHaveLength(1);
    expect(results.filter((result) => result === "pending")).toHaveLength(1);
  });

  it("treats a lock holder the Workflow reports as finished as stale", async () => {
    const { object } = createDurableObject({ a: { status: "errored" } });
    await object.acquire("key", "a");
    await expect(object.acquire("key", "b")).resolves.toBe("granted");
  });

  it("treats a lock holder the Workflow no longer knows as stale", async () => {
    const { object } = createDurableObject({ gone: { status: "running", unknown: true } });
    await object.acquire("key", "gone");
    await expect(object.acquire("key", "b")).resolves.toBe("granted");
  });

  it("lets a parked waiter take the key after the holder was cancelled without releasing", async () => {
    const holders: Record<string, { status: string }> = { holder: { status: "running" } };
    const { object } = createDurableObject(holders);
    const workflow: WorkflowBinding = { create: vi.fn(), get: vi.fn() };
    const coordinator = new DurableObjectConcurrencyCoordinator({ stub: () => object, workflow });
    const step = createStepMock();
    vi.mocked(step.waitForEvent).mockImplementation(async () => {
      holders.holder = { status: "terminated" };
      throw new Error("Timed out");
    });

    await object.acquire("org-1:catalog/import:store-1", "holder");
    const handler = vi.fn(async () => "ran");
    await expect(
      coordinator.run(payloadFor({ jobId: "waiter" }), step, handler),
    ).resolves.toBe("ran");
    expect(step.waitForEvent).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledOnce();
  });
});
