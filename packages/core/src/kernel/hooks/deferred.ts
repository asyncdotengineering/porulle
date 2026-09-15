import { AsyncLocalStorage } from "node:async_hooks";

interface DeferredStore {
  deferred: Array<() => Promise<void>>;
}

const deferredStorage = new AsyncLocalStorage<DeferredStore>();

export function isInsideTransaction(): boolean {
  return deferredStorage.getStore() != null;
}

export function deferAfterCommit(thunk: () => Promise<void>): boolean {
  const pending = deferredStorage.getStore();
  if (!pending) return false;
  pending.deferred.push(thunk);
  return true;
}

async function drainDeferred(pending: DeferredStore): Promise<void> {
  // `for...of` over a live array on purpose: a deferred hook that defers another one is drained
  // in the same pass rather than being dropped.
  for (const thunk of pending.deferred) {
    try {
      await thunk();
    } catch {
      // Each thunk logs its own hook failure (see runAfterHooks); swallow so siblings still run.
    }
  }
}

export async function withDeferredHooks<T>(fn: () => Promise<T>): Promise<T> {
  const existing = deferredStorage.getStore();
  if (existing) {
    return fn();
  }

  const pending: DeferredStore = { deferred: [] };
  // A throw propagates without reaching the drain: a rolled-back transaction discards its deferred
  // hooks rather than announcing a write that never happened. Stated rather than implied.
  const result = await deferredStorage.run(pending, fn);

  // AWAITED, never `void`. `adapter.transaction` resolving IS the commit, so the hooks below run
  // after commit — and they must still run INSIDE the invocation that started them. The Workers
  // runtime discards a promise that is neither awaited nor handed to `waitUntil` once the
  // invocation ends, which this codebase has already paid for once: a fire-and-forget queue nudge
  // wrote 104 outbox rows and sent ZERO messages on the deployed Worker while every Node test
  // passed. Detaching this drain would do the same to every webhook and search-index update in the
  // product. "After commit" is the requirement; "after the service method returns" is not, and is
  // what tempts you to detach it.
  await drainDeferred(pending);
  return result;
}
