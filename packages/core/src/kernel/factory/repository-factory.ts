import {
  eq,
  and,
  isNull,
  sql,
  getTableColumns,
  type SQL,
  type Column,
  type InferSelectModel,
  type InferInsertModel,
} from "drizzle-orm";
import type { PgTableWithColumns, TableConfig } from "drizzle-orm/pg-core";
import { PgTable } from "drizzle-orm/pg-core";
import type { TxContext } from "../database/tx-context.js";
import type { DrizzleDatabase, DbOrTx } from "../database/drizzle-db.js";
import { CommerceNotFoundError } from "../errors.js";

/**
 * Filter type — partial record of column values to match with eq().
 * Only keys that exist on TRow and have non-undefined values are used.
 */
export type Filters<TRow> = Partial<TRow>;

/**
 * Options for findMany / findAndCount queries.
 */
export interface FindOptions {
  limit?: number;
  offset?: number;
  orderBy?: Array<{ column: string; direction: "asc" | "desc" }>;
  withDeleted?: boolean;
}

/**
 * Standard CRUD operations derived from a Drizzle pgTable schema.
 * All methods support optional TxContext for transaction participation.
 */
export interface BaseRepository<TRow, TInsert> {
  findById(id: string, ctx?: TxContext): Promise<TRow | undefined>;
  findMany(
    filters?: Filters<TRow>,
    options?: FindOptions,
    ctx?: TxContext,
  ): Promise<TRow[]>;
  findAndCount(
    filters?: Filters<TRow>,
    options?: FindOptions,
    ctx?: TxContext,
  ): Promise<{ rows: TRow[]; total: number }>;
  create(data: TInsert, ctx?: TxContext): Promise<TRow>;
  createMany(data: TInsert[], ctx?: TxContext): Promise<TRow[]>;
  update(id: string, data: Partial<TInsert>, ctx?: TxContext): Promise<TRow>;
  delete(id: string, ctx?: TxContext): Promise<void>;
}

/**
 * Extended repository for tables with a `deleted_at` column.
 * Adds softDelete and restore operations.
 */
export interface SoftDeletableRepository<TRow, TInsert>
  extends BaseRepository<TRow, TInsert> {
  softDelete(id: string, ctx?: TxContext): Promise<void>;
  restore(id: string, ctx?: TxContext): Promise<TRow>;
}

/**
 * Type-level check: does the table config have a `deletedAt` or `deleted_at` column?
 */
type HasDeletedAt<T extends PgTableWithColumns<TableConfig>> =
  "deletedAt" extends keyof T ? true : "deleted_at" extends keyof T ? true : false;

/**
 * Conditional repository type: if the table has a deleted_at column,
 * return SoftDeletableRepository; otherwise BaseRepository.
 */
export type RepositoryFor<T extends PgTableWithColumns<TableConfig>> =
  HasDeletedAt<T> extends true
    ? SoftDeletableRepository<InferSelectModel<T>, InferInsertModel<T>>
    : BaseRepository<InferSelectModel<T>, InferInsertModel<T>>;

/**
 * Creates a typed repository with standard CRUD operations from a Drizzle table schema.
 *
 * Usage:
 * ```typescript
 * const repo = createRepository(schema.promotions, db)
 * const row = await repo.findById("abc-123")
 * const rows = await repo.findMany({ status: "active" }, { limit: 10 })
 * ```
 *
 * Tables with a `deletedAt` column automatically get `softDelete()` and `restore()`.
 * Domain-specific queries should remain in dedicated repository classes that
 * delegate standard CRUD to the factory-created instance.
 */
export function createRepository<T extends PgTableWithColumns<TableConfig>>(
  table: T,
  db: DrizzleDatabase,
): RepositoryFor<T> {
  // Use getTableColumns for type-safe column access
  const columns = getTableColumns(table) as Record<string, Column>;

  // Runtime check for soft-delete column
  const hasSoftDelete = "deletedAt" in columns || "deleted_at" in columns;
  const deletedAtColumn: Column | null =
    columns["deletedAt"] ?? columns["deleted_at"] ?? null;
  const idColumn = columns["id"]!;

  // Drizzle's generic types require PgTable at the boundary.
  // We cast once here rather than at every call site.
  const pgTable = table as PgTable;

  function getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? db;
  }

  function buildWhereConditions(
    filters?: Filters<InferSelectModel<T>>,
    includeDeleted = false,
  ): SQL[] {
    const conditions: SQL[] = [];

    // Automatically exclude soft-deleted rows unless explicitly requested
    if (hasSoftDelete && !includeDeleted && deletedAtColumn) {
      conditions.push(isNull(deletedAtColumn));
    }

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        const col = columns[key];
        if (value !== undefined && col) {
          conditions.push(eq(col, value));
        }
      }
    }

    return conditions;
  }

  const repo: BaseRepository<InferSelectModel<T>, InferInsertModel<T>> = {
    async findById(id, ctx) {
      const conditions = buildWhereConditions(undefined, false);
      conditions.push(eq(idColumn, id));
      const rows = await getDb(ctx)
        .select()
        .from(pgTable)
        .where(and(...conditions));
      return rows[0] as InferSelectModel<T> | undefined;
    },

    async findMany(filters, options = {}, ctx) {
      const conditions = buildWhereConditions(filters, options.withDeleted);
      let query = getDb(ctx).select().from(pgTable).$dynamic();
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }
      if (options.limit !== undefined) {
        query = query.limit(options.limit);
      }
      if (options.offset !== undefined) {
        query = query.offset(options.offset);
      }
      // Drizzle's $dynamic() erases the row type when using PgTable.
      // Use .then() to narrow the resolved array type with a single cast.
      return query.then((rows) => rows as InferSelectModel<T>[]);
    },

    async findAndCount(filters, options = {}, ctx) {
      const rows = await repo.findMany(filters, options, ctx);
      const conditions = buildWhereConditions(filters, options.withDeleted);
      let countQuery = getDb(ctx)
        .select({ count: sql<number>`count(*)::int` })
        .from(pgTable)
        .$dynamic();
      if (conditions.length > 0) {
        countQuery = countQuery.where(and(...conditions));
      }
      const countResult = await countQuery;
      return { rows, total: countResult[0]?.count ?? 0 };
    },

    async create(data, ctx) {
      const rows = await getDb(ctx)
        .insert(pgTable)
        .values(data as Record<string, unknown>)
        .returning();
      return rows[0] as InferSelectModel<T>;
    },

    async createMany(data, ctx) {
      if (data.length === 0) return [];
      const rows = await getDb(ctx)
        .insert(pgTable)
        .values(data as Record<string, unknown>[])
        .returning();
      return rows as InferSelectModel<T>[];
    },

    async update(id, data, ctx) {
      const rows = await getDb(ctx)
        .update(pgTable)
        .set(data as Record<string, unknown>)
        .where(eq(idColumn, id))
        .returning();
      if (!rows[0]) {
        throw new CommerceNotFoundError(`Record ${id} not found.`);
      }
      return rows[0] as InferSelectModel<T>;
    },

    async delete(id, ctx) {
      await getDb(ctx).delete(pgTable).where(eq(idColumn, id));
    },
  };

  if (hasSoftDelete && deletedAtColumn) {
    const softRepo = repo as SoftDeletableRepository<
      InferSelectModel<T>,
      InferInsertModel<T>
    >;

    softRepo.softDelete = async (id, ctx) => {
      await getDb(ctx)
        .update(pgTable)
        .set({ deletedAt: new Date() } as Record<string, unknown>)
        .where(eq(idColumn, id));
    };

    softRepo.restore = async (id, ctx) => {
      const rows = await getDb(ctx)
        .update(pgTable)
        .set({ deletedAt: null } as Record<string, unknown>)
        .where(eq(idColumn, id))
        .returning();
      if (!rows[0]) {
        throw new CommerceNotFoundError(`Record ${id} not found.`);
      }
      return rows[0] as InferSelectModel<T>;
    };

    return softRepo as RepositoryFor<T>;
  }

  return repo as RepositoryFor<T>;
}
