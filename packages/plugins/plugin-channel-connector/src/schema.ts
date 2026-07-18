import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "@porulle/core/drizzle";

export const connectedStores = pgTable(
  "connected_stores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    provider: text("provider").notNull(),
    credentials: jsonb("credentials").$type<Record<string, unknown>>().notNull(),
    storeDomain: text("store_domain").notNull(),
    status: text("status", { enum: ["connected", "disconnected", "error"] })
      .notNull()
      .default("connected"),
    catalogCursor: text("catalog_cursor"),
    inventoryCursor: text("inventory_cursor"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastReconcileAt: timestamp("last_reconcile_at", { withTimezone: true }),
    lastReconcileReport: jsonb("last_reconcile_report").$type<Record<string, unknown>>(),
    webhookSecret: text("webhook_secret"),
    breakerState: jsonb("breaker_state").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_connected_stores_org").on(table.organizationId),
    orgProviderIdx: index("idx_connected_stores_org_provider").on(table.organizationId, table.provider),
  }),
);

export const channelEntityMap = pgTable(
  "channel_entity_map",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    storeId: uuid("store_id").references(() => connectedStores.id, { onDelete: "cascade" }).notNull(),
    kind: text("kind", { enum: ["entity", "variant"] }).notNull(),
    externalId: text("external_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    variantId: uuid("variant_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
    syncHash: text("sync_hash").notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_entity_map_org").on(table.organizationId),
    storeIdx: index("idx_channel_entity_map_store").on(table.storeId),
    externalUnique: uniqueIndex("channel_entity_map_store_kind_external_unique").on(
      table.storeId,
      table.kind,
      table.externalId,
    ),
  }),
);

export const channelOrderExports = pgTable(
  "channel_order_exports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    storeId: uuid("store_id").references(() => connectedStores.id, { onDelete: "cascade" }).notNull(),
    orderId: uuid("order_id").notNull(),
    customerData: jsonb("customer_data").$type<{
      name: string;
      email: string;
      shippingAddress: Record<string, unknown>;
    }>(),
    state: text("state", { enum: ["pending", "exported", "confirmed", "failed", "abandoned"] })
      .notNull()
      .default("pending"),
    failureKind: text("failure_kind", { enum: ["definitive", "transient"] }),
    remoteOrderId: text("remote_order_id"),
    remoteUrl: text("remote_url"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_order_exports_org").on(table.organizationId),
    storeIdx: index("idx_channel_order_exports_store").on(table.storeId),
    stateIdx: index("idx_channel_order_exports_state").on(table.organizationId, table.state),
    orderIdx: index("idx_channel_order_exports_order").on(table.organizationId, table.orderId),
  }),
);

export const channelExportEvents = pgTable(
  "channel_export_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    exportId: uuid("export_id")
      .references(() => channelOrderExports.id, { onDelete: "cascade" })
      .notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_export_events_org").on(table.organizationId),
    exportIdx: index("idx_channel_export_events_export").on(table.exportId),
  }),
);

export const channelRefundRequests = pgTable(
  "channel_refund_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    storeId: uuid("store_id").references(() => connectedStores.id, { onDelete: "cascade" }).notNull(),
    orderId: uuid("order_id").notNull(),
    remoteRefundId: text("remote_refund_id").notNull(),
    amount: integer("amount").notNull(),
    state: text("state", { enum: ["requested", "approved", "rejected", "executed"] }).notNull().default("requested"),
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_refund_requests_org").on(table.organizationId),
    pendingIdx: index("idx_channel_refund_requests_pending").on(table.organizationId, table.state),
    remoteUnique: uniqueIndex("channel_refund_requests_store_remote_unique").on(table.storeId, table.remoteRefundId),
  }),
);

export const channelRefundEvents = pgTable(
  "channel_refund_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    requestId: uuid("request_id").references(() => channelRefundRequests.id, { onDelete: "cascade" }).notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_refund_events_org").on(table.organizationId),
    requestIdx: index("idx_channel_refund_events_request").on(table.requestId),
  }),
);

export type ConnectedStore = typeof connectedStores.$inferSelect;
export type ChannelEntityMapEntry = typeof channelEntityMap.$inferSelect;
export type ChannelOrderExport = typeof channelOrderExports.$inferSelect;
export type ChannelExportEvent = typeof channelExportEvents.$inferSelect;
export type ChannelRefundRequest = typeof channelRefundRequests.$inferSelect;
export type ChannelRefundEvent = typeof channelRefundEvents.$inferSelect;
