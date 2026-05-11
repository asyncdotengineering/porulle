/**
 * Drizzle Database Type Definitions
 *
 * This module provides type-safe, driver-agnostic database access for
 * PostgreSQL repositories.
 *
 * We use `PgDatabase` from `drizzle-orm/pg-core` — the base class that all
 * PostgreSQL drivers extend (postgres-js, pglite, node-postgres, bun-sql).
 * This means:
 *
 * - Repositories accept any PG driver without casts
 * - PGlite in tests and postgres-js in production use the same type
 * - Row types are fully inferred from pgTable schema definitions
 * - No coupling to any specific driver package
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/**
 * Combined schema type for type inference
 */
export type Schema = typeof schema;

/**
 * Driver-agnostic PostgreSQL database instance with full schema type
 * information.
 *
 * Both `PostgresJsDatabase<Schema>` and `PgliteDatabase<Schema>` are
 * assignable to this type, so repositories work identically in production
 * and tests without any casts.
 */
export type DrizzleDatabase = PgDatabase<PgQueryResultHKT, Schema>;

/**
 * Transaction type extracted from the database type.
 * Used when operating within a transaction context.
 *
 * This type is derived from the transaction callback parameter:
 * db.transaction(async (tx) => { ... })
 *                       ^^-- This is DrizzleTx
 */
export type DrizzleTx = Parameters<
  Parameters<DrizzleDatabase["transaction"]>[0]
>[0];

/**
 * Union type for database or transaction - repositories can accept either.
 * Both have the same query builder interface.
 */
export type DbOrTx = DrizzleDatabase | DrizzleTx;

/**
 * Re-export schema for convenience
 */
export { schema };
