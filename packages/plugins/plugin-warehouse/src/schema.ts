import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "@porulle/core/drizzle";

export const warehouseBins = pgTable("warehouse_bins", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  type: text("type", { enum: ["general", "cold", "frozen", "dry", "hazardous", "display"] }).notNull().default("general"),
  isActive: boolean("is_active").notNull().default(true),
  capacity: integer("capacity"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_warehouse_bins_org").on(table.organizationId),
  codeUnique: uniqueIndex("warehouse_bins_org_wh_code_unique").on(table.organizationId, table.warehouseId, table.code),
}));

export const stockTransfers = pgTable("stock_transfers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  transferNumber: text("transfer_number").notNull(),
  type: text("type", { enum: ["requisition", "direct", "return"] }).notNull().default("requisition"),
  status: text("status", { enum: ["draft", "pending_approval", "approved", "in_transit", "received", "cancelled"] }).notNull().default("draft"),
  fromWarehouseId: uuid("from_warehouse_id").notNull(),
  toWarehouseId: uuid("to_warehouse_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  approvedBy: text("approved_by"),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_stock_transfers_org").on(table.organizationId),
  statusIdx: index("idx_stock_transfers_status").on(table.status),
  numUnique: uniqueIndex("stock_transfers_org_num_unique").on(table.organizationId, table.transferNumber),
}));

export const stockTransferItems = pgTable("stock_transfer_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  transferId: uuid("transfer_id").references(() => stockTransfers.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  itemName: text("item_name").notNull(),
  quantityRequested: integer("quantity_requested").notNull(),
  quantityDispatched: integer("quantity_dispatched").notNull().default(0),
  quantityReceived: integer("quantity_received").notNull().default(0),
  batchNumber: text("batch_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  transferIdx: index("idx_stock_transfer_items_transfer").on(table.transferId),
}));

export const wastageNotes = pgTable("wastage_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  noteNumber: text("note_number").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  type: text("type", { enum: ["spoilage", "damage", "expiry", "theft", "prep_waste", "other"] }).notNull(),
  recordedBy: text("recorded_by").notNull(),
  approvedBy: text("approved_by"),
  totalCost: integer("total_cost").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_wastage_notes_org").on(table.organizationId),
  numUnique: uniqueIndex("wastage_notes_org_num_unique").on(table.organizationId, table.noteNumber),
}));

export const wastageNoteItems = pgTable("wastage_note_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  noteId: uuid("note_id").references(() => wastageNotes.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitCost: integer("unit_cost").notNull(),
  totalCost: integer("total_cost").notNull(),
  reason: text("reason"),
  batchNumber: text("batch_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  noteIdx: index("idx_wastage_note_items_note").on(table.noteId),
}));

export const stockReconciliations = pgTable("stock_reconciliations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  reconciliationNumber: text("reconciliation_number").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  status: text("status", { enum: ["draft", "counting", "submitted", "approved", "adjusted"] }).notNull().default("draft"),
  countedBy: text("counted_by").notNull(),
  approvedBy: text("approved_by"),
  countedAt: timestamp("counted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_stock_reconciliations_org").on(table.organizationId),
  numUnique: uniqueIndex("stock_reconciliations_org_num_unique").on(table.organizationId, table.reconciliationNumber),
}));

export const reconciliationItems = pgTable("reconciliation_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  reconciliationId: uuid("reconciliation_id").references(() => stockReconciliations.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  itemName: text("item_name").notNull(),
  systemQuantity: integer("system_quantity").notNull(),
  physicalQuantity: integer("physical_quantity").notNull(),
  variance: integer("variance").notNull(),
  varianceCost: integer("variance_cost").notNull().default(0),
  adjustmentMade: boolean("adjustment_made").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  recIdx: index("idx_reconciliation_items_rec").on(table.reconciliationId),
}));
