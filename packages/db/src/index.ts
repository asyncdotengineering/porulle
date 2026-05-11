/**
 * @porulle/db — single import for all database work.
 *
 * Plugin developers import everything from here instead of drizzle-orm directly.
 * Drizzle is an implementation detail — this package controls the surface.
 *
 *   import { defineTable, column, eq, and, desc, sql } from "@porulle/db";
 */

// ─── UC Abstractions ──────────────────────────────────────────────────
export { defineTable } from "./define-table.js";
export { column } from "./column.js";
export type { ColumnDef } from "./column.js";

// ─── Drizzle Query Operators (re-exported) ────────────────────────────
export {
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  like,
  ilike,
  notLike,
  inArray,
  notInArray,
  between,
  notBetween,
  isNull,
  isNotNull,
  exists,
  notExists,
  sql,
  asc,
  desc,
  count,
  sum,
  avg,
  min,
  max,
  countDistinct,
  sumDistinct,
  avgDistinct,
  getTableColumns,
} from "drizzle-orm";

// ─── Drizzle PG-Specific (re-exported) ───────────────────────────────
export {
  pgTable,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

// ─── Drizzle Types (re-exported for advanced use) ─────────────────────
export type {
  PgTable,
  PgDatabase,
  PgQueryResultHKT,
} from "drizzle-orm/pg-core";
