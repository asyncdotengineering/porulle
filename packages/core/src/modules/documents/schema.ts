import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";
import { orders } from "../orders/schema.js";

/**
 * Fiscal document sequences (issue #47).
 *
 * Per-(org, series) counters for legally sequential invoice numbers.
 * Allocation is a single atomic upsert-returning statement, so concurrent
 * requests never observe the same value.
 */
export const invoiceSequences = pgTable("invoice_sequences", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  series: text("series").notNull().default("default"),
  // The NEXT value to hand out; allocation returns the pre-increment value.
  nextValue: integer("next_value").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgSeriesUnique: uniqueIndex("invoice_sequences_org_series_unique").on(table.organizationId, table.series),
}));

/**
 * Issued documents (issue #47). One row per (org, order, type) — re-rendering
 * an order's invoice returns the number issued the first time, so a fiscal
 * number never changes once handed out.
 */
export const orderDocuments = pgTable("order_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  type: text("type").notNull(), // "invoice" | "receipt"
  documentNumber: text("document_number").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgOrderTypeUnique: uniqueIndex("order_documents_org_order_type_unique").on(table.organizationId, table.orderId, table.type),
  orgIdx: index("idx_order_documents_org").on(table.organizationId),
}));
