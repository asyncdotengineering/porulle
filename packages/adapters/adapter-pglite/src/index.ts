import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ensureDefaultOrg, pushSchema, type DatabaseAdapter } from "@porulle/core";
import * as schema from "@porulle/core/schema";

export interface PgliteAdapterOptions {
  /**
   * Filesystem path to persist the database (e.g. `"./.data/pgdata"`). Omit for
   * an ephemeral in-memory instance that is discarded on exit.
   */
  path?: string;
  /**
   * Push the core Drizzle schema on init (create tables if they don't exist),
   * so there is no separate migration step. Default: `true`. Set `false` if you
   * manage schema yourself.
   */
  migrate?: boolean;
  /**
   * Insert the default organization row after migrating, so single-tenant /
   * B2C stores work out of the box. Default: `true`.
   */
  seedDefaultOrg?: boolean;
}

/**
 * A zero-infrastructure `DatabaseAdapter` backed by PGlite — real PostgreSQL
 * compiled to WASM, running in-process. No database server to install, no
 * connection string, no migration command: construct it and the store runs.
 *
 * Ideal for local dev, demos, tests, and CI. For production, swap to
 * `@porulle/adapter-postgres` (same `DatabaseAdapter` contract).
 *
 * ```ts
 * // commerce.config.ts
 * import { defineConfig } from "@porulle/core";
 * import { pgliteAdapter } from "@porulle/adapter-pglite";
 *
 * export default defineConfig({
 *   databaseAdapter: await pgliteAdapter({ path: "./.data/pgdata" }),
 *   // ...
 * });
 * ```
 *
 * Requires `drizzle-kit` (used for the programmatic schema push) — it ships as a
 * dependency of this package.
 */
export async function pgliteAdapter(
  options: PgliteAdapterOptions = {},
): Promise<DatabaseAdapter> {
  const pg = options.path ? new PGlite(options.path) : new PGlite();
  const db = drizzle(pg, { schema });

  if (options.migrate !== false) {
    await pushSchema(db);
  }
  if (options.seedDefaultOrg !== false) {
    await ensureDefaultOrg(db);
  }

  // PGlite's Drizzle `transaction()` can deadlock under some drivers; manual
  // BEGIN/COMMIT/ROLLBACK on the raw instance is reliable.
  async function transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    await pg.exec("BEGIN");
    try {
      const result = await fn(db);
      await pg.exec("COMMIT");
      return result;
    } catch (error) {
      await pg.exec("ROLLBACK");
      throw error;
    }
  }

  // Signal the runtime to push any plugin-declared tables at boot: PGlite has
  // no separate migration step, and plugin schemas aren't known until plugins
  // run in defineConfig (after this adapter was constructed). Honors `migrate`.
  return {
    provider: "postgresql",
    db,
    transaction,
    autoMigrate: options.migrate !== false,
  };
}
