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
