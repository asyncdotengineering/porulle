import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

/**
 * Product tax classes (issue #57) — standard / reduced / zero-rated etc.
 * Sellable entities and variants reference a class by name (`taxClass`
 * column); checkout computes per-line tax from the class rate, with cart
 * discounts pro-rated across lines first. Lines with no class use the org's
 * default class (isDefault). When classes exist for an org they take
 * precedence over region rates and the adapter for line taxation.
 */
export const taxClasses = pgTable("tax_classes", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Basis points: 1000 = 10%
  rateBps: integer("rate_bps").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgNameUnique: uniqueIndex("tax_classes_org_name_unique").on(table.organizationId, table.name),
}));

/**
 * Runtime tax rates (issue #45).
 *
 * Per-region rates in basis points (500 = 5%). When rates exist for an
 * organization and the calculation has a destination address, they take
 * precedence over the configured tax adapter, which remains the fallback.
 * State-specific matches beat country-level matches; multiple matches at
 * the same specificity are summed (e.g. GST + PST).
 */
export const taxRates = pgTable("tax_rates", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // ISO 3166-1 alpha-2, uppercase. "*" matches any country.
  country: text("country").notNull(),
  // Optional state/province code; null = the whole country.
  state: text("state"),
  // Basis points: 500 = 5%, 875 = 8.75%
  rateBps: integer("rate_bps").notNull(),
  appliesToShipping: boolean("applies_to_shipping").notNull().default(true),
  priority: integer("priority").notNull().default(100),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_tax_rates_org").on(table.organizationId),
  countryIdx: index("idx_tax_rates_country").on(table.country, table.state),
}));
