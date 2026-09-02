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
  it("grants the lock immediately when the key is free", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage(), async () => false);
    await expect(logic.acquire("key", "a")).resolves.toBe("granted");
  });

  it("queues a second instance and hands it the lock on release", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage(), async () => false);
    await expect(logic.acquire("key", "a")).resolves.toBe("granted");
    await expect(logic.acquire("key", "b")).resolves.toBe("pending");

    await expect(logic.release("key", "a")).resolves.toEqual({ next: "b" });
    // "b" now holds the lock — a second release call for "a" (which no longer
    // holds it) must be a no-op, proving release doesn't hand out the lock twice.
    await expect(logic.release("key", "a")).resolves.toEqual({ next: null });
    await expect(logic.release("key", "b")).resolves.toEqual({ next: null });
  });

  it("treats a stale running instance as free and grants the new one", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage(), async (id) => id === "a");
    await expect(logic.acquire("key", "a")).resolves.toBe("granted");
    await expect(logic.acquire("key", "b")).resolves.toBe("granted");
  });

  it("drops a waiter from the pending queue when it re-acquires a key whose holder died", async () => {
    let holderDead = false;
    const logic = new JobCoordinatorLogic(createMemoryStorage(), async (id) => id === "a" && holderDead);
    await logic.acquire("key", "a");
    await expect(logic.acquire("key", "b")).resolves.toBe("pending");
    holderDead = true;
    await expect(logic.acquire("key", "b")).resolves.toBe("granted");
    await expect(logic.release("key", "b")).resolves.toEqual({ next: null });
  });

  it("enqueue with supersedes clears and returns the pending queue and registers the new instance", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage(), async () => false);
    await logic.acquire("key", "running");
    await logic.acquire("key", "pending-1");
    await logic.acquire("key", "pending-2");

    await expect(logic.enqueue("key", true, "new")).resolves.toEqual({
      terminated: ["pending-1", "pending-2"],
    });
    // The running instance was never touched by supersede; "new" is next in line.
    await expect(logic.acquire("key", "running")).resolves.toBe("granted");
    await expect(logic.release("key", "running")).resolves.toEqual({ next: "new" });
  });

  it("enqueue without supersedes appends to the queue", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage(), async () => false);
    await logic.acquire("key", "running");
    await logic.acquire("key", "pending-1");

    await expect(logic.enqueue("key", false, "new")).resolves.toEqual({ terminated: [] });
    await expect(logic.release("key", "running")).resolves.toEqual({ next: "pending-1" });
    await expect(logic.release("key", "pending-1")).resolves.toEqual({ next: "new" });
  });

  it("supersede terminates an instance that was enqueued but has not started running yet", async () => {
    const logic = new JobCoordinatorLogic(createMemoryStorage(), async () => false);
    await logic.enqueue("key", true, "gen-1");
    await expect(logic.enqueue("key", true, "gen-2")).resolves.toEqual({ terminated: ["gen-1"] });
    await expect(logic.enqueue("key", true, "gen-3")).resolves.toEqual({ terminated: ["gen-2"] });
    // Only the survivor can take the key; it is dropped from pending as it does.
    await expect(logic.acquire("key", "gen-3")).resolves.toBe("granted");
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
    expect(stub.enqueue).toHaveBeenCalledWith("org-1:catalog/import:store-1", true, "instance-1");
    expect(workflow.get).toHaveBeenCalledWith("old-1");
    expect(workflow.get).toHaveBeenCalledWith("old-2");
    expect(handle.terminate).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
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
    const workflow: WorkflowBinding = {
      create: vi.fn(),
      async get(id) {
        const entry = handles[id] ?? { status: "running" };
        if (entry.unknown) throw new Error(`instance ${id} does not exist`);
        return {
          status: async () => ({ status: entry.status as "running" }),
          terminate: async () => undefined,
          sendEvent: async () => {
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
          const run = gate.then(callback, callback);
          gate = run.catch(() => undefined);
          return run;
        },
      },
      { PORULLE_WORKFLOW: workflow },
    );
    return { object, sent };
  }

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
