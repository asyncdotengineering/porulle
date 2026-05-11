import { index, integer, boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "@porulle/core/drizzle";
import { customers } from "@porulle/core/schema";
import { organization } from "@porulle/core/auth-schema";

export const loyaltyPoints = pgTable("loyalty_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  points: integer("points").notNull().default(0),
  tier: text("tier", { enum: ["bronze", "silver", "gold", "platinum"] }).notNull().default("bronze"),
  lifetimeSpend: integer("lifetime_spend").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_loyalty_points_org").on(table.organizationId),
  orgCustomerUnique: uniqueIndex("loyalty_points_org_customer_unique").on(table.organizationId, table.customerId),
}));

export const loyaltyTransactions = pgTable("loyalty_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  orderId: uuid("order_id"),
  type: text("type", { enum: ["earn", "redeem"] }).notNull(),
  amount: integer("amount").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_loyalty_transactions_org").on(table.organizationId),
  customerIdx: index("idx_loyalty_transactions_customer").on(table.customerId),
}));

export const loyaltyRedemptionOffers = pgTable("loyalty_redemption_offers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  pointsRequired: integer("points_required").notNull(),
  rewardType: text("reward_type", { enum: ["discount_percentage", "discount_fixed", "free_item", "free_shipping"] }).notNull(),
  rewardValue: integer("reward_value").notNull(),
  rewardEntityId: uuid("reward_entity_id"),
  isActive: boolean("is_active").notNull().default(true),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  maxRedemptions: integer("max_redemptions"),
  timesRedeemed: integer("times_redeemed").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_loyalty_offers_org").on(table.organizationId),
}));
