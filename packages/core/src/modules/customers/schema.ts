import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  email: text("email"),
  phone: text("phone"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  posOperatorPin: text("pos_operator_pin"),
}, (table) => ({
  orgIdx: index("idx_customers_org").on(table.organizationId),
  orgUserIdUnique: uniqueIndex("customers_org_user_id_unique").on(table.organizationId, table.userId),
  orgEmailUnique: uniqueIndex("customers_org_email_unique").on(table.organizationId, table.email),
}));

export const customerAddresses = pgTable("customer_addresses", {
  id: uuid("id").defaultRandom().primaryKey(),
  customerId: uuid("customer_id")
    .references(() => customers.id, { onDelete: "cascade" })
    .notNull(),
  type: text("type", { enum: ["shipping", "billing"] }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  line1: text("line1").notNull(),
  line2: text("line2"),
  city: text("city").notNull(),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").notNull(),
  phone: text("phone"),
}, (table) => [
  index("idx_customer_addresses_customer_id").on(table.customerId),
]);

export const customerGroups = pgTable("customer_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
}, (table) => ({
  orgIdx: index("idx_customer_groups_org").on(table.organizationId),
  orgNameUnique: uniqueIndex("customer_groups_org_name_unique").on(table.organizationId, table.name),
}));

export const customerGroupMembers = pgTable("customer_group_members", {
  customerId: uuid("customer_id")
    .references(() => customers.id, { onDelete: "cascade" })
    .notNull(),
  groupId: uuid("group_id")
    .references(() => customerGroups.id, { onDelete: "cascade" })
    .notNull(),
}, (table) => [
  index("idx_group_members_customer_id").on(table.customerId),
  index("idx_group_members_group_id").on(table.groupId),
  uniqueIndex("customer_group_members_customer_group_unique").on(table.customerId, table.groupId),
]);
