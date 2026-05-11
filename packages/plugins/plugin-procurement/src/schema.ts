import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "@porulle/core/drizzle";

export const suppliers = pgTable("suppliers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  currency: text("currency").notNull().default("USD"),
  taxId: text("tax_id"),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_suppliers_org").on(table.organizationId),
  codeUnique: uniqueIndex("suppliers_org_code_unique").on(table.organizationId, table.code),
}));

export const supplierItems = pgTable("supplier_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  supplierSku: text("supplier_sku"),
  unitCost: integer("unit_cost").notNull(),
  minOrderQuantity: integer("min_order_quantity").notNull().default(1),
  leadTimeDays: integer("lead_time_days").notNull().default(1),
  isPreferred: boolean("is_preferred").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  supplierIdx: index("idx_supplier_items_supplier").on(table.supplierId),
}));

export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  poNumber: text("po_number").notNull(),
  supplierId: uuid("supplier_id").references(() => suppliers.id).notNull(),
  status: text("status", { enum: ["draft", "pending_approval", "approved", "sent", "partially_received", "received", "cancelled"] }).notNull().default("draft"),
  warehouseId: uuid("warehouse_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  expectedDelivery: timestamp("expected_delivery", { withTimezone: true }),
  subtotal: integer("subtotal").notNull().default(0),
  taxTotal: integer("tax_total").notNull().default(0),
  grandTotal: integer("grand_total").notNull().default(0),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_purchase_orders_org").on(table.organizationId),
  statusIdx: index("idx_purchase_orders_status").on(table.status),
  poNumUnique: uniqueIndex("purchase_orders_org_po_unique").on(table.organizationId, table.poNumber),
}));

export const purchaseOrderItems = pgTable("purchase_order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  poId: uuid("po_id").references(() => purchaseOrders.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  itemName: text("item_name").notNull(),
  quantityOrdered: integer("quantity_ordered").notNull(),
  quantityReceived: integer("quantity_received").notNull().default(0),
  unitCost: integer("unit_cost").notNull(),
  totalCost: integer("total_cost").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  poIdx: index("idx_po_items_po").on(table.poId),
}));

export const goodsReceivedNotes = pgTable("goods_received_notes", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  grnNumber: text("grn_number").notNull(),
  poId: uuid("po_id").references(() => purchaseOrders.id).notNull(),
  supplierId: uuid("supplier_id").references(() => suppliers.id).notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  receivedBy: text("received_by").notNull(),
  status: text("status", { enum: ["draft", "inspecting", "accepted", "accepted_with_discrepancy", "rejected"] }).notNull().default("draft"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_grn_org").on(table.organizationId),
  poIdx: index("idx_grn_po").on(table.poId),
  grnNumUnique: uniqueIndex("grn_org_number_unique").on(table.organizationId, table.grnNumber),
}));

export const grnItems = pgTable("grn_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  grnId: uuid("grn_id").references(() => goodsReceivedNotes.id, { onDelete: "cascade" }).notNull(),
  poItemId: uuid("po_item_id").references(() => purchaseOrderItems.id).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  quantityOrdered: integer("quantity_ordered").notNull(),
  quantityReceived: integer("quantity_received").notNull(),
  quantityAccepted: integer("quantity_accepted").notNull(),
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  rejectionReason: text("rejection_reason"),
  batchNumber: text("batch_number"),
  expiryDate: timestamp("expiry_date", { withTimezone: true }),
  unitCost: integer("unit_cost").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  grnIdx: index("idx_grn_items_grn").on(table.grnId),
}));
