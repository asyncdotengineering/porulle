import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";
import { sellableEntities, variants } from "../catalog/schema.js";

export const prices = pgTable(
  "prices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .references(() => sellableEntities.id, { onDelete: "cascade" })
      .notNull(),
    variantId: uuid("variant_id").references(() => variants.id, { onDelete: "cascade" }),
    currency: text("currency").notNull(),
    amount: integer("amount").notNull(),
    customerGroupId: text("customer_group_id"),
    minQuantity: integer("min_quantity"),
    maxQuantity: integer("max_quantity"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    entityVariantCurrencyIdx: index("idx_prices_entity_variant_currency").on(
      table.entityId,
      table.variantId,
      table.currency,
    ),
    customerGroupIdx: index("idx_prices_customer_group").on(table.customerGroupId),
    quantityIdx: index("idx_prices_quantity").on(table.minQuantity, table.maxQuantity),
    validityIdx: index("idx_prices_validity").on(table.validFrom, table.validUntil),
    orgIdx: index("idx_prices_org").on(table.organizationId),
  }),
);

export const priceModifiers = pgTable(
  "price_modifiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["percentage_discount", "fixed_discount", "markup", "override"],
    }).notNull(),
    value: integer("value").notNull(),
    priority: integer("priority").notNull().default(100),
    entityId: uuid("entity_id").references(() => sellableEntities.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => variants.id, { onDelete: "cascade" }),
    customerGroupId: text("customer_group_id"),
    currency: text("currency").default("USD"),
    minQuantity: integer("min_quantity"),
    maxQuantity: integer("max_quantity"),
    conditions: jsonb("conditions").$type<Record<string, unknown>>().default({}),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    entityVariantIdx: index("idx_price_modifiers_entity_variant").on(table.entityId, table.variantId),
    priorityIdx: index("idx_price_modifiers_priority").on(table.priority),
    orgIdx: index("idx_price_modifiers_org").on(table.organizationId),
  }),
);
