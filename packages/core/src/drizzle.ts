/**
 * Re-exports of drizzle-orm primitives from @porulle/core.
 *
 * Why this exists: bun's peer-dep deduping creates separate hash variants
 * of drizzle-orm@0.45.1 based on which peers each consumer pulls in
 * (drizzle-zod is a common splitter — core depends on it; most plugins
 * don't). When a plugin defines `pgTable(...)` via its own drizzle copy
 * but the kernel passes a `db` instance from core's drizzle copy,
 * TypeScript treats the two `PgTable<TableConfig>` as nominally
 * distinct types — even though structurally identical. Type errors
 * cascade through every `db.select().from(<table>)` call site.
 *
 * The fix: route all plugin drizzle imports through this subpath so
 * they resolve via core's drizzle copy. Plugins import `pgTable`,
 * `eq`, `sql`, etc. from `@porulle/core/drizzle` rather than
 * `drizzle-orm/pg-core` and `drizzle-orm` directly.
 *
 * Workspace policy: plugin schemas and services SHOULD import drizzle
 * primitives from this module. Direct imports of `drizzle-orm/pg-core`
 * still work but may cause type drift in plugins that lack FK
 * references to core tables.
 */

export {
  pgTable,
  pgSchema,
  pgSequence,
  text,
  varchar,
  integer,
  bigint,
  smallint,
  boolean,
  timestamp,
  date,
  time,
  decimal,
  doublePrecision,
  json,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
  customType,
  serial,
  real,
} from "drizzle-orm/pg-core";

export {
  sql,
  eq,
  ne,
  and,
  or,
  not,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  between,
  notBetween,
  like,
  notLike,
  ilike,
  notIlike,
  exists,
  notExists,
  gt,
  gte,
  lt,
  lte,
  asc,
  desc,
  count,
  sum,
  avg,
  max,
  min,
  arrayContains,
  arrayContained,
  arrayOverlaps,
  getTableColumns,
  getTableName,
} from "drizzle-orm";

export type { SQL } from "drizzle-orm";
export type { PgColumn, PgTable, PgTableWithColumns, AnyPgColumn } from "drizzle-orm/pg-core";

// Driver-specific db type used by app-side scripts and plugin glue
// that wire the runtime DB instance. Apps import this as the parameter
// type for functions that receive a Drizzle-postgres-js database.
export type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
