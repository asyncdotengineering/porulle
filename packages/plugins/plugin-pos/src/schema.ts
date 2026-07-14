/**
 * POS Plugin Schema — Tier 0 Core Primitives
 *
 * 6 tables replacing the old single pos_sessions table:
 * - pos_terminals: physical register/device registry
 * - pos_shifts: operator working periods with cash tracking
 * - pos_cash_events: cash drawer operations within a shift
 * - pos_transactions: individual sales, returns, exchanges
 * - pos_payments: payment records (supports split tender)
 * - pos_return_items: links return transactions to original order line items
 */

import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "@porulle/core/drizzle";

// ─── Terminals ──────────────────────────────────────────────────────────

export const posTerminals = pgTable("pos_terminals", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  type: text("type", { enum: ["register", "tablet", "mobile", "kiosk"] }).notNull().default("register"),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_terminals_org").on(table.organizationId),
  codeUnique: uniqueIndex("pos_terminals_org_code_unique").on(table.organizationId, table.code),
}));

// ─── Shifts ─────────────────────────────────────────────────────────────

export const posShifts = pgTable("pos_shifts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  terminalId: uuid("terminal_id").references(() => posTerminals.id, { onDelete: "cascade" }).notNull(),
  operatorId: text("operator_id").notNull(),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  openingFloat: integer("opening_float").notNull().default(0),
  closingCount: integer("closing_count"),
  expectedCash: integer("expected_cash"),
  cashVariance: integer("cash_variance"),
  salesCount: integer("sales_count").notNull().default(0),
  salesTotal: integer("sales_total").notNull().default(0),
  refundsCount: integer("refunds_count").notNull().default(0),
  refundsTotal: integer("refunds_total").notNull().default(0),
  voidsCount: integer("voids_count").notNull().default(0),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_shifts_org").on(table.organizationId),
  terminalIdx: index("idx_pos_shifts_terminal").on(table.terminalId),
}));

// ─── Cash Events ────────────────────────────────────────────────────────

export const posCashEvents = pgTable("pos_cash_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  shiftId: uuid("shift_id").references(() => posShifts.id, { onDelete: "cascade" }).notNull(),
  type: text("type", { enum: ["float", "drop", "pickup", "paid_in", "paid_out"] }).notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason"),
  performedBy: text("performed_by").notNull(),
  performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  shiftIdx: index("idx_pos_cash_events_shift").on(table.shiftId),
}));

// ─── Transactions ───────────────────────────────────────────────────────

export const posTransactions = pgTable("pos_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  shiftId: uuid("shift_id").references(() => posShifts.id, { onDelete: "cascade" }).notNull(),
  terminalId: uuid("terminal_id").references(() => posTerminals.id).notNull(),
  operatorId: text("operator_id").notNull(),
  cartId: uuid("cart_id").notNull(),
  orderId: uuid("order_id"),
  type: text("type", { enum: ["sale", "return", "exchange"] }).notNull().default("sale"),
  status: text("status", { enum: ["open", "held", "completed", "voided"] }).notNull().default("open"),
  customerId: uuid("customer_id"),
  receiptNumber: text("receipt_number").notNull(),
  subtotal: integer("subtotal").notNull().default(0),
  taxTotal: integer("tax_total").notNull().default(0),
  total: integer("total").notNull().default(0),
  discountTotal: integer("discount_total").notNull().default(0),
  holdLabel: text("hold_label"),
  voidReason: text("void_reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => ({
  orgIdx: index("idx_pos_transactions_org").on(table.organizationId),
  shiftIdx: index("idx_pos_transactions_shift").on(table.shiftId),
  statusIdx: index("idx_pos_transactions_status").on(table.status),
  receiptIdx: index("idx_pos_transactions_receipt").on(table.receiptNumber),
}));

// ─── Payments (Tenders) ─────────────────────────────────────────────────

export const posPayments = pgTable("pos_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionId: uuid("transaction_id").references(() => posTransactions.id, { onDelete: "cascade" }).notNull(),
  method: text("method", { enum: ["cash", "card", "gift_card", "store_credit", "other"] }).notNull(),
  amount: integer("amount").notNull(),
  changeGiven: integer("change_given").notNull().default(0),
  reference: text("reference"),
  status: text("status", { enum: ["collected", "refunded"] }).notNull().default("collected"),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  transactionIdx: index("idx_pos_payments_transaction").on(table.transactionId),
}));

// ─── Operator PINs (issue #51) ──────────────────────────────────────────

export const posOperatorPins = pgTable("pos_operator_pins", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  operatorId: text("operator_id").notNull(),
  // PBKDF2-SHA256, encoded as pbkdf2$<iterations>$<saltB64>$<hashB64>
  pinHash: text("pin_hash").notNull(),
  // Manager override capability — checked by POST /pos/auth/override.
  canOverride: boolean("can_override").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgOperatorUnique: uniqueIndex("pos_operator_pins_org_operator_unique").on(table.organizationId, table.operatorId),
}));

// ─── PIN attempt lockout (SEC-15) ───────────────────────────────────────

export const posPinAttempts = pgTable("pos_pin_attempts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  operatorId: text("operator_id").notNull(),
  failedCount: integer("failed_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgOperatorUnique: uniqueIndex("pos_pin_attempts_org_operator_unique").on(table.organizationId, table.operatorId),
}));

// ─── Return Items ───────────────────────────────────────────────────────

export const posReturnItems = pgTable("pos_return_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  transactionId: uuid("transaction_id").references(() => posTransactions.id, { onDelete: "cascade" }).notNull(),
  originalOrderId: uuid("original_order_id").notNull(),
  originalLineItemId: uuid("original_line_item_id").notNull(),
  quantity: integer("quantity").notNull(),
  reason: text("reason", { enum: ["defective", "wrong_item", "changed_mind", "other"] }).notNull(),
  restockingFee: integer("restocking_fee").notNull().default(0),
  refundAmount: integer("refund_amount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  transactionIdx: index("idx_pos_return_items_transaction").on(table.transactionId),
  originalOrderIdx: index("idx_pos_return_items_order").on(table.originalOrderId),
}));
