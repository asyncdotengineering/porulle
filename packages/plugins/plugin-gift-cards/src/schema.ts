import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  check,
  uniqueIndex,
} from "@porulle/core/drizzle";
import { sql } from "@porulle/core/drizzle";

// ─── Gift Cards ──────────────────────────────────────────────────────────────

export const giftCards = pgTable(
  "gift_cards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    code: text("code").notNull(),
    initialAmount: integer("initial_amount").notNull(),
    balance: integer("balance").notNull(),
    currency: text("currency").notNull(),
    status: text("status", {
      enum: ["active", "disabled", "exhausted"],
    })
      .notNull()
      .default("active"),
    purchaserId: text("purchaser_id"),
    recipientEmail: text("recipient_email"),
    senderName: text("sender_name"),
    personalMessage: text("personal_message"),
    sourceOrderId: text("source_order_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    version: integer("version").notNull().default(0),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    orgCodeUnique: uniqueIndex("gift_cards_org_code_unique").on(table.organizationId, table.code),
    orgIdx: index("idx_gift_cards_org").on(table.organizationId),
    codeIdx: index("idx_gift_cards_code").on(table.code),
    purchaserIdx: index("idx_gift_cards_purchaser").on(table.purchaserId),
    statusIdx: index("idx_gift_cards_status").on(table.status),
    balanceCheck: check(
      "gift_cards_balance_non_negative",
      sql`${table.balance} >= 0`,
    ),
    initialAmountCheck: check(
      "gift_cards_initial_amount_positive",
      sql`${table.initialAmount} > 0`,
    ),
  }),
);

// ─── Gift Card Transactions ─────────────────────────────────────────────────

export const giftCardTransactions = pgTable(
  "gift_card_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    giftCardId: uuid("gift_card_id")
      .notNull()
      .references(() => giftCards.id, { onDelete: "cascade" }),
    type: text("type", {
      enum: ["debit", "credit", "refund"],
    }).notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    orderId: text("order_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    cardIdx: index("idx_gc_txn_card").on(table.giftCardId),
    orderIdx: index("idx_gc_txn_order").on(table.orderId),
  }),
);
