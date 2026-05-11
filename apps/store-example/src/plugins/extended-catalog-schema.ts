/**
 * Extended catalog schema — demonstrates adding custom columns to core tables.
 *
 * Extends base `sellable_entities` columns with `supplierCode` and `countryOfOrigin`.
 * These columns are created by `db:push`
 * when this file is referenced in the app's `drizzle.config.ts`.
 *
 * Usage:
 *   1. Add this file to `drizzle.config.ts` schema array
 *   2. Run `bun run db:push` to add the columns
 *   3. Query via this table object to get type-safe access to the new columns
 */

import { pgTable, text, uuid, boolean, jsonb, timestamp } from "@porulle/core/drizzle";
import { organization } from "@porulle/core/auth-schema";

/**
 * Base columns matching the core `sellable_entities` table.
 * We must re-declare them here so Drizzle can produce a merged table definition.
 */
const baseColumns = {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  slug: text("slug").notNull(),
  status: text("status", {
    enum: ["draft", "active", "archived", "discontinued"],
  })
    .notNull()
    .default("draft"),
  isVisible: boolean("is_visible").notNull().default(false),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
};

/**
 * Extended `sellable_entities` table with app-specific columns.
 * Drizzle merges these into the same physical table during `db:push`.
 */
export const extendedSellableEntities = pgTable(
  "sellable_entities",
  {
    ...baseColumns,
    supplierCode: text("supplier_code"),
    countryOfOrigin: text("country_of_origin"),
  },
);
