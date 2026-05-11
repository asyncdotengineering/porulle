/**
 * defineTable — table definition wrapper for UnifiedCommerce plugins.
 *
 * Wraps Drizzle's pgTable with auto-injected fields:
 * - id (UUID primary key)
 * - organizationId (text, NOT NULL) — on top-level tables only
 * - createdAt, updatedAt (timestamps)
 * - Org index + composite unique constraints
 *
 * Child tables (FK to org-scoped parent) get id + createdAt only.
 *
 * Usage:
 *   import { defineTable, column } from "@porulle/db";
 *
 *   export const giftCards = defineTable("gift_cards", {
 *     code: column.text({ unique: true }),
 *     balance: column.integer(),
 *   });
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { getTableColumns } from "drizzle-orm";
import type { ColumnDef } from "./column.js";

function hasOrgColumn(table: unknown): boolean {
  if (!table || typeof table !== "object") return false;
  try {
    const cols = getTableColumns(table as Parameters<typeof getTableColumns>[0]);
    return "organizationId" in cols;
  } catch {
    return false;
  }
}

function toSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapColumn(name: string, def: ColumnDef): any {
  const sn = toSnake(name);

  switch (def._type) {
    case "text": {
      let c = def.enum ? text(sn, { enum: def.enum as [string, ...string[]] }) : text(sn);
      if (def.default !== undefined) c = c.default(def.default) as typeof c;
      if (!def.optional) c = c.notNull() as typeof c;
      return c;
    }
    case "integer": {
      let c = integer(sn);
      if (def.default !== undefined) c = c.default(def.default) as typeof c;
      if (!def.optional) c = c.notNull() as typeof c;
      return c;
    }
    case "boolean": {
      let c = boolean(sn);
      if (def.default !== undefined) c = c.default(def.default) as typeof c;
      if (!def.optional) c = c.notNull() as typeof c;
      return c;
    }
    case "uuid": {
      let c = uuid(sn);
      if (def.references) {
        const refCols = getTableColumns(def.references as Parameters<typeof getTableColumns>[0]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        c = c.references(() => (refCols as any).id, { onDelete: "cascade" }) as typeof c;
      }
      if (!def.optional) c = c.notNull() as typeof c;
      return c;
    }
    case "timestamp": {
      let c = timestamp(sn, { withTimezone: true });
      if (def.default === "now") c = c.defaultNow() as typeof c;
      if (!def.optional) c = c.notNull() as typeof c;
      return c;
    }
    case "json": {
      let c = jsonb(sn);
      if (def.default !== undefined) c = c.default(def.default) as typeof c;
      if (!def.optional) c = c.notNull() as typeof c;
      return c;
    }
  }
}

/**
 * Define a database table with auto-injected UC fields.
 */
export function defineTable(
  name: string,
  columnDefs: Record<string, ColumnDef>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraConfig?: (table: Record<string, any>) => Record<string, any>,
) {
  // Detect child table: any UUID column references an org-scoped parent?
  let isChild = false;
  for (const def of Object.values(columnDefs)) {
    if (def._type === "uuid" && def.references && hasOrgColumn(def.references)) {
      isChild = true;
      break;
    }
  }

  // Map user columns to Drizzle builders
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cols: Record<string, any> = {};
  const uniqueCols: string[] = [];

  for (const [colName, def] of Object.entries(columnDefs)) {
    cols[colName] = mapColumn(colName, def);
    if ("unique" in def && def.unique) {
      uniqueCols.push(colName);
    }
  }

  // Build full column set with auto-injected fields
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allColumns: Record<string, any> = {
    id: uuid("id").defaultRandom().primaryKey(),
  };

  if (!isChild) {
    allColumns.organizationId = text("organization_id").notNull();
  }

  Object.assign(allColumns, cols);

  allColumns.createdAt = timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull();

  if (!isChild) {
    allColumns.updatedAt = timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull();
  }

  // Create pgTable with indexes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = pgTable(name, allColumns as any, (t: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const indexes: Record<string, any> = {};

    if (!isChild) {
      indexes.orgIdx = index(`idx_${name}_org`).on(t.organizationId);

      for (const colName of uniqueCols) {
        const sn = toSnake(colName);
        indexes[`${colName}Unique`] = uniqueIndex(`${name}_org_${sn}_unique`)
          .on(t.organizationId, t[colName]);
      }
    }

    if (extraConfig) Object.assign(indexes, extraConfig(t));
    return indexes;
  });

  // Mark for scoped DB proxy
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (table as any).__ucOrgScoped = !isChild;

  return table;
}
