/**
 * Column definition helpers for defineTable.
 *
 * These produce config objects that defineTable maps to Drizzle column builders.
 * Plugin developers use these instead of importing from drizzle-orm/pg-core directly.
 *
 *   import { defineTable, column } from "@porulle/db";
 *
 *   export const giftCards = defineTable("gift_cards", {
 *     // Per-org unique (default): UNIQUE (organization_id, code)
 *     code: column.text({ unique: true }),
 *     // Globally unique across all tenants: UNIQUE (public_code)
 *     publicCode: column.text({ unique: "global" }),
 *     balance: column.integer(),
 *     status: column.text({ enum: ["active", "disabled"], default: "active" }),
 *   });
 *
 * Child tables (FK to org-scoped parent) have no organizationId; unique: true
 * creates UNIQUE (col) on the child column.
 */

export type ColumnUnique = boolean | "global";

export interface TextColumnDef {
  readonly _type: "text";
  unique?: ColumnUnique;
  optional?: boolean;
  enum?: readonly string[];
  default?: string;
}

export interface IntegerColumnDef {
  readonly _type: "integer";
  unique?: ColumnUnique;
  optional?: boolean;
  default?: number;
}

export interface BooleanColumnDef {
  readonly _type: "boolean";
  optional?: boolean;
  default?: boolean;
}

export interface UuidColumnDef {
  readonly _type: "uuid";
  optional?: boolean;
  references?: unknown; // PgTable reference for FK detection
}

export interface TimestampColumnDef {
  readonly _type: "timestamp";
  optional?: boolean;
  default?: "now";
}

export interface JsonColumnDef {
  readonly _type: "json";
  optional?: boolean;
  default?: unknown;
}

export type ColumnDef =
  | TextColumnDef
  | IntegerColumnDef
  | BooleanColumnDef
  | UuidColumnDef
  | TimestampColumnDef
  | JsonColumnDef;

export const column = {
  text: (opts?: Omit<TextColumnDef, "_type">): TextColumnDef => ({
    _type: "text" as const,
    ...opts,
  }),

  integer: (opts?: Omit<IntegerColumnDef, "_type">): IntegerColumnDef => ({
    _type: "integer" as const,
    ...opts,
  }),

  boolean: (opts?: Omit<BooleanColumnDef, "_type">): BooleanColumnDef => ({
    _type: "boolean" as const,
    ...opts,
  }),

  uuid: (opts?: Omit<UuidColumnDef, "_type">): UuidColumnDef => ({
    _type: "uuid" as const,
    ...opts,
  }),

  timestamp: (opts?: Omit<TimestampColumnDef, "_type">): TimestampColumnDef => ({
    _type: "timestamp" as const,
    ...opts,
  }),

  json: (opts?: Omit<JsonColumnDef, "_type">): JsonColumnDef => ({
    _type: "json" as const,
    ...opts,
  }),
};
