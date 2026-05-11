import { pgTable, uuid, text, timestamp, index, jsonb } from "@porulle/core/drizzle";

export const scheduledOrders = pgTable("scheduled_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  cartId: uuid("cart_id").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  orderType: text("order_type", { enum: ["pickup", "delivery", "dine_in"] }).notNull().default("pickup"),
  status: text("status", { enum: ["scheduled", "processing", "completed", "cancelled", "expired"] }).notNull().default("scheduled"),
  pickupLocation: text("pickup_location"),
  deliveryAddress: jsonb("delivery_address"),
  notes: text("notes"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_scheduled_orders_org").on(table.organizationId),
  statusIdx: index("idx_scheduled_orders_status").on(table.status),
  scheduledForIdx: index("idx_scheduled_orders_scheduled_for").on(table.scheduledFor),
}));
