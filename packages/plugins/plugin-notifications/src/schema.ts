import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex, jsonb } from "@porulle/core/drizzle";

export const notificationTemplates = pgTable("notification_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  event: text("event").notNull(),
  channel: text("channel", { enum: ["email", "sms", "push", "print"] }).notNull(),
  subject: text("subject"),
  bodyTemplate: text("body_template").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_notification_templates_org").on(table.organizationId),
  orgEventChannelUnique: uniqueIndex("notification_templates_org_event_channel_unique").on(
    table.organizationId, table.event, table.channel,
  ),
}));

export const customerNotificationPrefs = pgTable("customer_notification_prefs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  channel: text("channel", { enum: ["email", "sms", "push"] }).notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  destination: text("destination"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_customer_notification_prefs_org").on(table.organizationId),
  orgCustomerChannelUnique: uniqueIndex("customer_notification_prefs_org_cust_channel_unique").on(
    table.organizationId, table.customerId, table.channel,
  ),
}));

export const notificationLog = pgTable("notification_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  channel: text("channel").notNull(),
  event: text("event").notNull(),
  recipient: text("recipient").notNull(),
  status: text("status", { enum: ["queued", "sent", "delivered", "failed"] }).notNull().default("queued"),
  error: text("error"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_notification_log_org").on(table.organizationId),
  channelIdx: index("idx_notification_log_channel").on(table.channel),
  eventIdx: index("idx_notification_log_event").on(table.event),
  statusIdx: index("idx_notification_log_status").on(table.status),
}));

export const printJobs = pgTable("print_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  type: text("type", { enum: ["receipt", "label", "sticker", "kot"] }).notNull(),
  printerId: text("printer_id").notNull(),
  content: jsonb("content").notNull().default({}),
  status: text("status", { enum: ["queued", "printing", "printed", "failed"] }).notNull().default("queued"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_print_jobs_org").on(table.organizationId),
  statusIdx: index("idx_print_jobs_status").on(table.status),
  printerIdx: index("idx_print_jobs_printer").on(table.printerId),
}));
