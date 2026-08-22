/**
 * Canonical database types for plugin service constructors.
 *
 * Replaces the copy-pasted type definitions in every plugin's types.ts:
 *   type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>
 *
 * Import from core instead:
 *   import type { PluginDb, PluginTxFn } from "@porulle/core";
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * Database instance type for plugin services.
 * This is the Drizzle PgDatabase with an opaque schema record.
 *
 * Tenant scoping depends on which handle you were given, not on this type.
 * `PluginContext.database.db` is wrapped so that `insert`, `select`, `update`
 * and `delete` on any table with an `organizationId` column are constrained to
 * the request's organization. `PluginContext.database.unscoped` and the kernel
 * handle passed to `config.routes` are not wrapped at all.
 *
 * `execute()` is never scoped, on any handle — see the scope-boundary note in
 * `scoped-db.ts`. When you drop to raw SQL, filter by organization yourself and
 * interpolate values as bind parameters (`sql`... ${value}`) rather than
 * through `sql.raw`.
 */
export type PluginDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Transaction function type for plugin services that need
 * transactional guarantees (e.g., POS transaction complete,
 * gift card debit, inventory reservation).
 *
 * Usage:
 *   constructor(private db: PluginDb, private txFn: PluginTxFn) {}
 *
 *   async doWork() {
 *     return this.txFn(async (tx) => {
 *       await tx.insert(...).values(...);
 *       await tx.update(...).set(...);
 *     });
 *   }
 */
export type PluginTxFn = <T>(fn: (tx: PluginDb) => Promise<T>) => Promise<T>;
