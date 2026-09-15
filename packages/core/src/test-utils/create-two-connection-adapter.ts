/**
 * A test adapter whose transaction handle and `db` handle are two DIFFERENT connections.
 *
 * Every other test adapter in this repo is one PGlite instance, which hands the transaction body
 * the SAME `db` handle it hands everyone else. That makes a whole class of defect invisible by
 * construction: a write issued on the `db` handle while a transaction is open rides that open
 * transaction, so it commits and rolls back with it, and a test asserting "the write rolled back"
 * passes whether or not the code under test routed the write through `tx` at all.
 *
 * On the driver this project actually deploys — Neon over HTTP — every plain query on the `db`
 * handle is its own request on its own connection. Such a write does NOT join the open transaction
 * and SURVIVES its rollback. Measured on the deployed Worker, 2026-09-15:
 *
 *     POST /api/loom/_proof/abort-after-hook
 *     committed: false   entity_exists = 0   pending_for_aborted = 1
 *
 * This adapter reproduces that property with two PGlite instances: transactions run on one, the
 * `db` handle is the other. The two do not share data, which a real two-connection driver would —
 * that is the one way it is unlike Neon, and it is why the assertions below name WHICH connection
 * a row landed on rather than reading either one alone.
 */

import type { DatabaseAdapter } from "../kernel/database/adapter.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";
import { createPGliteTestAdapter } from "./create-pglite-adapter.js";

export interface TwoConnectionTestAdapter {
  adapter: DatabaseAdapter;
  /** The connection `adapter.transaction` opens its transaction on. */
  txDb: DrizzleDatabase;
  /** The connection `adapter.db` points at — the "outside" connection. */
  outsideDb: DrizzleDatabase;
  cleanup: () => Promise<void>;
}

export async function createTwoConnectionTestAdapter(): Promise<TwoConnectionTestAdapter> {
  const transactional = await createPGliteTestAdapter();
  const outside = await createPGliteTestAdapter();

  const adapter: DatabaseAdapter = {
    provider: "postgresql",
    db: outside.db,
    transaction: transactional.adapter.transaction,
  };

  return {
    adapter,
    txDb: transactional.db,
    outsideDb: outside.db,
    cleanup: async () => {
      await transactional.cleanup();
      await outside.cleanup();
    },
  };
}
