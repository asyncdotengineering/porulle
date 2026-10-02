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
 * the second BEGIN is a no-op Postgres only warns about — and share a snapshot
 * and each other's row locks. Bodies are queued instead, which is what a
 * connection pool does to two transactions competing for the same rows. A
 * nested call joins the open transaction rather than deadlocking on the queue;
 * without savepoints that is the only sound reading.
 */
export function createPGliteTransaction(pg: PGliteExec, db: unknown): {
  transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
  /** Whether a transaction body is executing right now. */
  inTransaction(): boolean;
} {
  let queue: Promise<unknown> = Promise.resolve();
  let open = false;

  async function transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    if (open) return fn(db);
    const run = queue.then(async () => {
      open = true;
      await pg.exec("BEGIN");
      try {
        const result = await fn(db);
        await pg.exec("COMMIT");
        return result;
      } catch (error) {
        await pg.exec("ROLLBACK");
        throw error;
      } finally {
        open = false;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return { transaction, inTransaction: () => open };
}
