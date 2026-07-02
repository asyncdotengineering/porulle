/**
 * Layaway plugin schema (issue #58).
 *
 * - layaways: a partial-payment plan reserving items until fully paid.
 *   `status` is stored but always derived from payments: active →
 *   completed (paidTotal >= total, creates the core order + releases the
 *   reservation hold) or forfeited/cancelled (releases the hold).
 * - layaway_payments: installment ledger (any tender).
 */

import { pgTable, uuid, text, integer, timestamp, jsonb, index } from "@porulle/core/drizzle";

export interface LayawayItem {
  entityId: string;
  variantId?: string | undefined;
  sku?: string | undefined;
  title: string;
  quantity: number;
  unitPrice: number;
}

export const layaways = pgTable("layaways", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  customerId: uuid("customer_id"),
  status: text("status", { enum: ["active", "completed", "forfeited", "cancelled"] }).notNull().default("active"),
  currency: text("currency").notNull(),
  items: jsonb("items").$type<LayawayItem[]>().notNull(),
  total: integer("total").notNull(),
  depositAmount: integer("deposit_amount").notNull().default(0),
  paidTotal: integer("paid_total").notNull().default(0),
  // Core order created at completion.
  orderId: uuid("order_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  forfeitedAt: timestamp("forfeited_at", { withTimezone: true }),
  forfeitReason: text("forfeit_reason"),
  createdBy: text("created_by").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_layaways_org").on(table.organizationId),
  statusIdx: index("idx_layaways_status").on(table.status),
  customerIdx: index("idx_layaways_customer").on(table.customerId),
}));

export const layawayPayments = pgTable("layaway_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  layawayId: uuid("layaway_id").references(() => layaways.id, { onDelete: "cascade" }).notNull(),
  amount: integer("amount").notNull(),
  method: text("method").notNull(),
  reference: text("reference"),
  performedBy: text("performed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  layawayIdx: index("idx_layaway_payments_layaway").on(table.layawayId),
}));
