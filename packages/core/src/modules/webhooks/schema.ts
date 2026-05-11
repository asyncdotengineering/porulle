import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").$type<string[]>().notNull(),
    isActive: boolean("is_active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => ({
    orgIdx: index("idx_webhook_endpoints_org").on(table.organizationId),
  }),
);

/**
 * Tracks processed incoming webhook events for idempotency.
 * Prevents double-processing when Stripe (or other providers) retry delivery.
 */
export const processedWebhookEvents = pgTable("processed_webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: text("event_id").notNull().unique(),
  provider: text("provider").notNull(), // "stripe", "paypal", etc.
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).defaultNow().notNull(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  endpointId: uuid("endpoint_id")
    .references(() => webhookEndpoints.id)
    .notNull(),
  eventName: text("event_name").notNull(),
  payload: jsonb("payload").notNull(),
  statusCode: integer("status_code"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
