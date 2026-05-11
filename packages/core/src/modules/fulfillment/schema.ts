import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";
import { orders, orderLineItems } from "../orders/schema.js";
import { customers } from "../customers/schema.js";

/**
 * Fulfillment Records Table
 *
 * Tracks physical shipments, digital deliveries, and access grants.
 * Each fulfillment can be associated with one or more order line items.
 */
export const fulfillmentRecords = pgTable("fulfillment_records", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  customerId: uuid("customer_id").references(() => customers.id),

  // Fulfillment type: "physical", "digital", "access_grant"
  type: text("type").notNull(),

  // Status: "pending", "processing", "shipped", "delivered", "cancelled", "failed"
  status: text("status").notNull().default("pending"),

  // Physical shipment fields
  carrier: text("carrier"),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  estimatedDelivery: timestamp("estimated_delivery", { withTimezone: true }),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),

  // Digital delivery fields
  downloadUrl: text("download_url"),
  downloadExpiresAt: timestamp("download_expires_at", { withTimezone: true }),
  maxDownloads: integer("max_downloads"),
  downloadCount: integer("download_count").notNull().default(0),

  // Access grant fields (e.g., course access, membership)
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),

  // Metadata for extensibility
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Fulfillment Line Items Junction Table
 *
 * Links fulfillment records to order line items (many-to-many).
 * Allows partial fulfillments where only some items from an order are fulfilled together.
 */
export const fulfillmentLineItems = pgTable("fulfillment_line_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  fulfillmentId: uuid("fulfillment_id")
    .references(() => fulfillmentRecords.id, { onDelete: "cascade" })
    .notNull(),
  orderLineItemId: uuid("order_line_item_id")
    .references(() => orderLineItems.id, { onDelete: "cascade" })
    .notNull(),
  quantity: integer("quantity").notNull(),
});

/**
 * Fulfillment Events Table
 *
 * Audit trail of fulfillment status changes and events.
 */
export const fulfillmentEvents = pgTable("fulfillment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  fulfillmentId: uuid("fulfillment_id")
    .references(() => fulfillmentRecords.id, { onDelete: "cascade" })
    .notNull(),
  eventType: text("event_type").notNull(), // "created", "shipped", "delivered", "cancelled", "download", etc.
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  description: text("description"),
  actorId: text("actor_id"), // User/system that triggered the event
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
