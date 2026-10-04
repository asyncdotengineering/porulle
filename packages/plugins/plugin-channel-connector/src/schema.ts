import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  sql,
} from "@porulle/core/drizzle";
import type { ChannelOrderAddress, ChannelPushCatalogItem, FieldPath } from "@porulle/core";
import { sellableEntities } from "@porulle/core/schema";
import type { CatalogFieldMapping } from "./catalog-field-mapping.js";

/** What the last on-visit check found. `webhooks`: subscriptions all active, recreated, or still failing. */
export interface StoreHealth {
  checkedAt: string;
  webhooks: "ok" | "repaired" | "failing" | "not_applicable";
  repaired: number;
  missing: string[];
  keyValid: boolean;
  /** Why the check could not finish, when it could not. */
  error?: string;
}

export const connectedStores = pgTable(
  "connected_stores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    provider: text("provider").notNull(),
    credentials: jsonb("credentials").$type<Record<string, unknown>>().notNull(),
    storeDomain: text("store_domain").notNull(),
    status: text("status", { enum: ["connecting", "connected", "disconnected", "error"] })
      .notNull()
      .default("connected"),
    /** Why the store is in `error`, in words the merchant can act on. Null in every other status. */
    statusReason: text("status_reason"),
    /** The last check of the store's webhooks and key, made on a merchant's visit (never on a schedule). */
    health: jsonb("health").$type<StoreHealth>(),
    /** When the store last delivered a webhook we accepted. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    catalogWriteEnabled: boolean("catalog_write_enabled").notNull().default(false),
    catalogFieldMapping: jsonb("catalog_field_mapping").$type<CatalogFieldMapping>().notNull().default([]),
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
    entityId: uuid("entity_id").references(() => sellableEntities.id, { onDelete: "cascade" }).notNull(),
    variantId: uuid("variant_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).defaultNow().notNull(),
    syncHash: text("sync_hash").notNull(),
    outboundHash: text("outbound_hash"),
    outboundPushedAt: timestamp("outbound_pushed_at", { withTimezone: true }),
    outboundFieldPaths: jsonb("outbound_field_paths").$type<FieldPath[]>().notNull().default([]),
    heldFieldPaths: jsonb("held_field_paths").$type<FieldPath[]>().notNull().default([]),
    forcedPushFieldPaths: jsonb("forced_push_field_paths").$type<FieldPath[]>().notNull().default([]),
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

/**
 * The category, brand and tag links a store's converge CREATED on an entity — link provenance, per
 * store, the way `channel_entity_map` records the variants a store owns. A converge removes a link
 * the store dropped only when the link is on record here: a link the merchant added (or another
 * store did) has no row for this store and is never this store's to take away.
 */
export const channelEntityLinks = pgTable(
  "channel_entity_links",
  {
    organizationId: text("organization_id").notNull(),
    storeId: uuid("store_id").references(() => connectedStores.id, { onDelete: "cascade" }).notNull(),
    entityId: uuid("entity_id").references(() => sellableEntities.id, { onDelete: "cascade" }).notNull(),
    kind: text("kind", { enum: ["category", "brand", "tag"] }).notNull(),
    targetId: uuid("target_id").notNull(),
  },
  (table) => ({
    linkUnique: uniqueIndex("channel_entity_links_store_entity_kind_target_unique").on(table.storeId, table.entityId, table.kind, table.targetId),
  }),
);

export const channelCatalogConflicts = pgTable(
  "channel_catalog_conflicts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    storeId: uuid("store_id").references(() => connectedStores.id, { onDelete: "cascade" }).notNull(),
    entityId: uuid("entity_id").references(() => sellableEntities.id, { onDelete: "cascade" }).notNull(),
    fieldPath: text("field_path").notNull(),
    platformValue: jsonb("platform_value").$type<unknown>().notNull(),
    storeValue: jsonb("store_value").$type<unknown>().notNull(),
    state: text("state", { enum: ["open", "resolved"] }).notNull().default("open"),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_catalog_conflicts_org").on(table.organizationId),
    stateIdx: index("idx_channel_catalog_conflicts_org_state").on(table.organizationId, table.state),
    openUnique: uniqueIndex("channel_catalog_conflicts_open_unique")
      .on(table.storeId, table.entityId, table.fieldPath)
      .where(sql`${table.state} = 'open'`),
  }),
);

export const channelCatalogConflictEvents = pgTable(
  "channel_catalog_conflict_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    conflictId: uuid("conflict_id").references(() => channelCatalogConflicts.id, { onDelete: "cascade" }).notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_catalog_conflict_events_org").on(table.organizationId),
    conflictIdx: index("idx_channel_catalog_conflict_events_conflict").on(table.conflictId),
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
      shippingAddress: ChannelOrderAddress;
    }>(),
    state: text("state", { enum: ["pending", "exported", "confirmed", "failed", "abandoned"] })
      .notNull()
      .default("pending"),
    failureKind: text("failure_kind", { enum: ["definitive", "transient"] }),
    remoteOrderId: text("remote_order_id"),
    remoteUrl: text("remote_url"),
    /** When the store's side of the order was last read by a read point catching up a missed delivery. */
    remoteCheckedAt: timestamp("remote_checked_at", { withTimezone: true }),
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

export const channelCatalogPushes = pgTable(
  "channel_catalog_pushes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    storeId: uuid("store_id").references(() => connectedStores.id, { onDelete: "cascade" }).notNull(),
    entityId: uuid("entity_id").references(() => sellableEntities.id, { onDelete: "cascade" }).notNull(),
    payloadSnapshot: jsonb("payload_snapshot").$type<ChannelPushCatalogItem | null>(),
    state: text("state", { enum: ["pending", "exported", "confirmed", "failed", "abandoned"] })
      .notNull()
      .default("pending"),
    failureKind: text("failure_kind", { enum: ["definitive", "transient"] }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_catalog_pushes_org").on(table.organizationId),
    storeIdx: index("idx_channel_catalog_pushes_store").on(table.storeId),
    stateIdx: index("idx_channel_catalog_pushes_state").on(table.organizationId, table.state),
    entityIdx: index("idx_channel_catalog_pushes_entity").on(table.organizationId, table.entityId),
    storeEntityUnique: uniqueIndex("channel_catalog_pushes_store_entity_unique").on(
      table.storeId,
      table.entityId,
    ),
  }),
);

export const channelCatalogPushEvents = pgTable(
  "channel_catalog_push_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    pushId: uuid("push_id")
      .references(() => channelCatalogPushes.id, { onDelete: "cascade" })
      .notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    reason: text("reason"),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_channel_catalog_push_events_org").on(table.organizationId),
    pushIdx: index("idx_channel_catalog_push_events_push").on(table.pushId),
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

/**
 * A return the marketplace asked a store to take, and the store's answer so far. The refund for it
 * arrives separately, on the store's own refund webhook.
 */
export const channelReturns = pgTable(
  "channel_returns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    storeId: uuid("store_id").references(() => connectedStores.id, { onDelete: "cascade" }).notNull(),
    orderId: uuid("order_id").notNull(),
    remoteReturnId: text("remote_return_id").notNull(),
    status: text("status", { enum: ["requested", "approved", "declined", "closed", "cancelled"] }).notNull().default("requested"),
    lines: jsonb("lines").$type<Array<{ orderLineItemId: string; quantity: number }>>().notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orderIdx: index("idx_channel_returns_order").on(table.organizationId, table.orderId),
    remoteUnique: uniqueIndex("channel_returns_store_remote_unique").on(table.storeId, table.remoteReturnId),
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
export type ChannelCatalogConflict = typeof channelCatalogConflicts.$inferSelect;
export type ChannelCatalogConflictEvent = typeof channelCatalogConflictEvents.$inferSelect;
export type ChannelCatalogPush = typeof channelCatalogPushes.$inferSelect;
export type ChannelCatalogPushEvent = typeof channelCatalogPushEvents.$inferSelect;
export type ChannelOrderExport = typeof channelOrderExports.$inferSelect;
export type ChannelExportEvent = typeof channelExportEvents.$inferSelect;
export type ChannelRefundRequest = typeof channelRefundRequests.$inferSelect;
export type ChannelRefundEvent = typeof channelRefundEvents.$inferSelect;
