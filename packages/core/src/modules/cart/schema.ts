import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";
import { sellableEntities, variants } from "../catalog/schema.js";

export const carts = pgTable("carts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id"),
  status: text("status", {
    enum: ["active", "checking_out", "merged", "checked_out", "abandoned"],
  })
    .notNull()
    .default("active"),
  currency: text("currency").notNull().default("USD"),
  // Shopper contact for guest carts — enables abandoned-checkout recovery
  email: text("email"),
  secret: text("secret"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_carts_org").on(table.organizationId),
  customerIdIdx: index("idx_carts_customer_id").on(table.customerId),
  statusIdx: index("idx_carts_status").on(table.status),
  expiresAtIdx: index("idx_carts_expires_at").on(table.expiresAt),
}));

export const cartLineItems = pgTable("cart_line_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  cartId: uuid("cart_id")
    .references(() => carts.id, { onDelete: "cascade" })
    .notNull(),
  entityId: uuid("entity_id").references(() => sellableEntities.id).notNull(),
  variantId: uuid("variant_id").references(() => variants.id),
  quantity: integer("quantity").notNull().default(1),
  unitPriceSnapshot: integer("unit_price_snapshot").notNull(),
  currency: text("currency").notNull(),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_cart_line_items_cart_id").on(table.cartId),
]);
