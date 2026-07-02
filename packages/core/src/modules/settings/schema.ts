import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

/**
 * Org-scoped runtime settings (issue #49).
 *
 * One row per (organization, group). Groups are shallow JSON objects —
 * `general` (currency, timezone, locale), `branding` (receipt header/footer,
 * store name, logo), `policies` (free-form policy knobs), plus any custom
 * group a plugin namespaces for itself. PATCH semantics are shallow merge
 * with `null` deleting a key.
 */
export const storeSettings = pgTable("store_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  group: text("group").notNull(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgGroupUnique: uniqueIndex("store_settings_org_group_unique").on(table.organizationId, table.group),
  orgIdx: index("idx_store_settings_org").on(table.organizationId),
}));
