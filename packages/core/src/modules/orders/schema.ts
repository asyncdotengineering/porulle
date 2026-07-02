import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";
import { sellableEntities, variants } from "../catalog/schema.js";

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  orderNumber: text("order_number").notNull(),
  customerId: uuid("customer_id"),
  status: text("status").notNull().default("pending"),
  currency: text("currency").notNull(),
  subtotal: integer("subtotal").notNull(),
  taxTotal: integer("tax_total").notNull(),
  shippingTotal: integer("shipping_total").notNull(),
  discountTotal: integer("discount_total").notNull().default(0),
  grandTotal: integer("grand_total").notNull(),
  amountCaptured: integer("amount_captured"),
  paymentIntentId: text("payment_intent_id"),
  paymentMethodId: text("payment_method_id"),
  // Client-supplied key making order creation safely retryable (offline POS
  // queues, network retries) — replays return the original order.
  idempotencyKey: text("idempotency_key"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  placedAt: timestamp("placed_at", { withTimezone: true }).defaultNow().notNull(),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (table) => ({
  orgIdx: index("idx_orders_org").on(table.organizationId),
  orgOrderNumberUnique: uniqueIndex("orders_org_order_number_unique").on(table.organizationId, table.orderNumber),
  statusIdx: index("idx_orders_status").on(table.status),
  customerIdIdx: index("idx_orders_customer_id").on(table.customerId),
  placedAtIdx: index("idx_orders_placed_at").on(table.placedAt),
  paymentIntentIdx: index("idx_orders_payment_intent").on(table.paymentIntentId),
  orgIdempotencyKeyUnique: uniqueIndex("orders_org_idempotency_key_unique")
    .on(table.organizationId, table.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
}));

export const orderLineItems = pgTable("order_line_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  entityId: uuid("entity_id").references(() => sellableEntities.id).notNull(),
  entityType: text("entity_type").notNull(),
  variantId: uuid("variant_id").references(() => variants.id),
  sku: text("sku"),
  title: text("title").notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),
  totalPrice: integer("total_price").notNull(),
  taxAmount: integer("tax_amount").notNull().default(0),
  discountAmount: integer("discount_amount").notNull().default(0),
  // Units already refunded on this line (issue #52) — line-level refund REST
  // rejects refunds beyond `quantity - refundedQuantity`.
  refundedQuantity: integer("refunded_quantity").notNull().default(0),
  fulfillmentStatus: text("fulfillment_status").notNull().default("unfulfilled"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
}, (table) => [
  index("idx_order_line_items_order_id").on(table.orderId),
  index("idx_order_line_items_entity_id").on(table.entityId),
]);

/**
 * Line-level refunds (issue #52). One row per refund operation — the ledger
 * behind the daily refund cap and the undo window. `lines` records which
 * line items and quantities the refund covered so undo can restore them.
 */
export const orderRefunds = pgTable("order_refunds", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  orderId: uuid("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason"),
  lines: jsonb("lines").$type<Array<{ lineItemId: string; quantity: number; amount: number }>>().notNull(),
  performedBy: text("performed_by").notNull(),
  status: text("status", { enum: ["completed", "undone"] }).notNull().default("completed"),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  undoneBy: text("undone_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_order_refunds_order_id").on(table.orderId),
  index("idx_order_refunds_org_performed_by").on(table.organizationId, table.performedBy, table.createdAt),
]);

export const orderStatusHistory = pgTable("order_status_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  fromStatus: text("from_status").notNull(),
  toStatus: text("to_status").notNull(),
  reason: text("reason"),
  changedBy: text("changed_by").notNull(),
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_order_status_history_order_id").on(table.orderId),
]);
