import { AsyncLocalStorage } from "node:async_hooks";

/** The one PGlite capability a transaction needs: run a statement on the connection. */
export interface PGliteExec {
  exec(statement: string): Promise<unknown>;
}

/**
 * `DatabaseAdapter.transaction` for a PGlite instance.
 *
 * Drizzle's own `transaction()` can hang on PGlite, so this drives
 * BEGIN/COMMIT/ROLLBACK directly and hands the body the same `db` handle.
 *
 * PGlite is a single connection, so two bodies awaiting concurrently would
 * otherwise interleave their statements between one BEGIN and one COMMIT —
 * the second BEGIN is a no-op Postgres only warns about — and share a snapshot,
 * each other's row locks and each other's rollback. Bodies are queued instead,
 * which is what a connection pool does to two transactions competing for the
 * same rows.
 *
 * Only a call made from INSIDE a running body joins it (without savepoints that
 * is the only sound reading of a nested call). "Inside" is decided by the async
 * context the call runs in, never by whether some transaction happens to be
 * open: an unrelated request that arrives mid-body queues behind it.
 */
export function createPGliteTransaction(pg: PGliteExec, db: unknown): {
  transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
  /** Whether a transaction body is executing right now. */
  inTransaction(): boolean;
} {
  // Each transaction gets its own token; a call joins only when it runs inside
  // the body of the transaction that is open right now (work a body started
  // but did not await may outlive it, and must not join a closed transaction).
  const body = new AsyncLocalStorage<object>();
  let queue: Promise<unknown> = Promise.resolve();
  let current: object | null = null;

  async function transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const caller = body.getStore();
    if (caller !== undefined && caller === current) return fn(db);
    const run = queue.then(async () => {
      await pg.exec("BEGIN");
      const token = {};
      current = token;
      try {
        const result = await body.run(token, () => fn(db));
        await pg.exec("COMMIT");
        return result;
      } catch (error) {
        await pg.exec("ROLLBACK");
        throw error;
      } finally {
        current = null;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return { transaction, inTransaction: () => current !== null };
}
