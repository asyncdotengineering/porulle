import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "@porulle/core/drizzle";
import { customers } from "@porulle/core/schema";

export const loyaltyPoints = pgTable("loyalty_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  customerId: uuid("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  points: integer("points").notNull().default(0),
  tier: text("tier", {
    enum: ["bronze", "silver", "gold", "platinum"],
  })
    .notNull()
    .default("bronze"),
  lifetimeSpend: integer("lifetime_spend").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_loyalty_points_org").on(table.organizationId),
  orgCustomerUnique: uniqueIndex("loyalty_points_org_customer_unique")
    .on(table.organizationId, table.customerId),
}));

export const loyaltyTransactions = pgTable("loyalty_transactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
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
