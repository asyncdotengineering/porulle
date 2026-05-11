import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

export const promotions = pgTable(
  "promotions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    code: text("code"),
    name: text("name").notNull(),
    type: text("type", {
      enum: [
        "percentage_off_order",
        "fixed_off_order",
        "percentage_off_item",
        "fixed_off_item",
        "free_shipping",
        "buy_x_get_y",
      ],
    }).notNull(),
    value: integer("value").notNull().default(0),
    buyQuantity: integer("buy_quantity"),
    getQuantity: integer("get_quantity"),
    isAutomatic: boolean("is_automatic").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    priority: integer("priority").notNull().default(100),
    conditions: jsonb("conditions").$type<Record<string, unknown>>().default({}),
    usageLimitTotal: integer("usage_limit_total"),
    usageLimitPerCustomer: integer("usage_limit_per_customer"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    codeIdx: index("idx_promotions_code").on(table.code),
    activePriorityIdx: index("idx_promotions_active_priority").on(table.isActive, table.priority),
    validityIdx: index("idx_promotions_validity").on(table.validFrom, table.validUntil),
    orgIdx: index("idx_promotions_org").on(table.organizationId),
    orgCodeUnique: uniqueIndex("promotions_org_code_unique").on(table.organizationId, table.code),
  }),
);

export const promotionUsages = pgTable(
  "promotion_usages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    promotionId: uuid("promotion_id")
      .references(() => promotions.id, { onDelete: "cascade" })
      .notNull(),
    customerId: uuid("customer_id"),
    orderId: uuid("order_id"),
    usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    promotionIdx: index("idx_promotion_usage_promotion").on(table.promotionId),
    customerIdx: index("idx_promotion_usage_customer").on(table.customerId),
  }),
);
