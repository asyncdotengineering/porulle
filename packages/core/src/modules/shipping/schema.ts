import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

/**
 * Runtime shipping configuration (issue #45).
 *
 * Zones match a destination (country + optional state); rates belong to a
 * zone and carry a flat amount with optional subtotal/weight bands and a
 * free-shipping threshold. When zones exist for an organization they take
 * precedence over the code-config strategy in `defineConfig({ shipping })`,
 * which remains the fallback.
 */
export const shippingZones = pgTable("shipping_zones", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // ISO 3166-1 alpha-2 codes, uppercase. "*" matches any country.
  countries: jsonb("countries").$type<string[]>().notNull().default([]),
  // Optional state/province codes; empty array = the whole country.
  states: jsonb("states").$type<string[]>().notNull().default([]),
  priority: integer("priority").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_shipping_zones_org").on(table.organizationId),
  priorityIdx: index("idx_shipping_zones_priority").on(table.priority),
}));

export const shippingRates = pgTable("shipping_rates", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  zoneId: uuid("zone_id")
    .notNull()
    .references(() => shippingZones.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currency: text("currency").notNull().default("USD"),
  // Flat cost in minor units
  amount: integer("amount").notNull(),
  // Price bands (subtotal after discount, minor units) — nulls are open-ended
  minSubtotal: integer("min_subtotal"),
  maxSubtotal: integer("max_subtotal"),
  // Weight bands (grams) — nulls are open-ended
  minWeightGrams: integer("min_weight_grams"),
  maxWeightGrams: integer("max_weight_grams"),
  // Subtotal at or above which shipping is free for this rate
  freeShippingThreshold: integer("free_shipping_threshold"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  zoneIdx: index("idx_shipping_rates_zone").on(table.zoneId),
  orgIdx: index("idx_shipping_rates_org").on(table.organizationId),
}));
