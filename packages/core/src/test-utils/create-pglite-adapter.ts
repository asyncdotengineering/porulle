/**
 * PGlite-backed test adapter for real PostgreSQL behavior in tests.
 *
 * Creates an in-memory PGlite (WASM PostgreSQL) instance, pushes the
 * core Drizzle schema programmatically via drizzle-kit/api, and provides
 * a cleanup function to reset data between tests.
 *
 * Benefits over in-memory repository doubles:
 * - Real SQL execution (Drizzle query generation)
 * - PostgreSQL type coercion and constraint enforcement
 * - Real transaction rollback semantics
 * - Production parity for query edge cases
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { createRequire } from "node:module";
import type { DatabaseAdapter } from "../kernel/database/adapter.js";
import { getSchema } from "../kernel/database/migrate.js";
import { ensureDefaultOrg } from "../auth/org.js";

// Single barrel import --- includes all core modules + auth tables
import * as fullSchema from "../kernel/database/schema.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";

// drizzle-kit/api uses CJS internally; createRequire provides ESM compat.
const require = createRequire(import.meta.url);

/**
 * Pushes the core Drizzle schema to the database using drizzle-kit/api.
 *
 * drizzle-kit introspects the live database via information_schema, diffs
 * against the pgTable definitions, and generates the minimal DDL needed.
 * Typed as DrizzleDatabase (our concrete schema type) to avoid the
 * PGlite → PgDatabase<HKT> invariance cast — drizzle-kit accepts any
 * Drizzle instance at runtime regardless of the schema generic.
 */
async function pushCoreSchema(db: DrizzleDatabase): Promise<void> {
  const coreSchema = getSchema();
  const drizzleKit = require("drizzle-kit/api") as {
    pushSchema(
      imports: Record<string, unknown>,
      drizzleInstance: DrizzleDatabase,
    ): Promise<{ apply: () => Promise<void> }>;
  };
  const { apply } = await drizzleKit.pushSchema(coreSchema, db);
  await apply();
}

/**
 * Creates a PGlite-backed database adapter for testing.
 *
 * Each call creates a new isolated PGlite instance with its own
 * in-memory database. Core schema is pushed once during initialization.
 *
 * @returns A promise resolving to an object containing:
 *   - adapter: The DatabaseAdapter for use with createKernel
 *   - db: The Drizzle ORM instance for direct queries
 *   - cleanup: Function to truncate all tables (call between tests)
 */
export async function createPGliteTestAdapter(): Promise<{
  adapter: DatabaseAdapter;
  db: DrizzleDatabase;
  cleanup: () => Promise<void>;
}> {
  // Create in-memory PGlite instance
  const pg = new PGlite();

  // Wrap with Drizzle ORM first (pushSchema needs the Drizzle instance)
  const db = drizzle(pg, { schema: fullSchema });

  // Push core schema via drizzle-kit/api (no migration files needed)
  // PgliteDatabase<Schema> and DrizzleDatabase share the same Schema type;
  // the HKT parameter differs (PgliteQueryResultHKT vs PgQueryResultHKT)
  // but drizzle-kit's pushSchema doesn't use it at runtime.
  await pushCoreSchema(db as DrizzleDatabase);

  // Ensure the default organization exists for all tests
  await ensureDefaultOrg(db);

  /**
   * PGlite-compatible transaction wrapper.
   *
   * Drizzle's transaction() method can hang with PGlite due to how
   * the adapter manages transaction state. This implementation uses
   * manual BEGIN/COMMIT control which works more reliably.
   */
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

  const adapter: DatabaseAdapter = {
    provider: "postgresql",
    db,
    transaction,
  };

  /**
   * Cleanup function to reset data between tests.
   * Truncates all tables in reverse dependency order with CASCADE.
   */
  async function cleanup(): Promise<void> {
    await db.execute(sql`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (
          SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
        ) LOOP
          EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    // Re-insert default org after truncation (CASCADE wipes it)
    await ensureDefaultOrg(db);
  }

  return { adapter, db, cleanup };
}
