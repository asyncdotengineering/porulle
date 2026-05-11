import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from "@porulle/core/drizzle";

export const productionBoms = pgTable("production_boms", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  name: text("name").notNull(),
  version: integer("version").default(1),
  yieldQuantity: integer("yield_quantity").default(1),
  yieldUomId: uuid("yield_uom_id"),
  isActive: boolean("is_active").default(true),
  level: integer("level").default(0),
  totalCost: integer("total_cost").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_production_boms_org").on(table.organizationId),
  entityIdx: index("idx_production_boms_entity").on(table.entityId),
}));

export const productionBomItems = pgTable("production_bom_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  bomId: uuid("bom_id").references(() => productionBoms.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull(),
  unitCost: integer("unit_cost").default(0),
  totalCost: integer("total_cost").default(0),
  uomId: uuid("uom_id"),
  isSubAssembly: boolean("is_sub_assembly").default(false),
  subBomId: uuid("sub_bom_id").references(() => productionBoms.id),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  bomIdx: index("idx_production_bom_items_bom").on(table.bomId),
}));

export const productionOrders = pgTable("production_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  orderNumber: text("order_number").notNull(),
  bomId: uuid("bom_id").references(() => productionBoms.id).notNull(),
  entityId: uuid("entity_id").notNull(),
  quantity: integer("quantity").notNull(),
  warehouseId: uuid("warehouse_id").notNull(),
  status: text("status", { enum: ["planned", "in_progress", "completed", "cancelled"] }).default("planned").notNull(),
  plannedDate: timestamp("planned_date", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  producedBy: text("produced_by"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_production_orders_org").on(table.organizationId),
  statusIdx: index("idx_production_orders_status").on(table.status),
  orderNumUnique: uniqueIndex("production_orders_org_number_unique").on(table.organizationId, table.orderNumber),
}));

export const productionConsumption = pgTable("production_consumption", {
  id: uuid("id").defaultRandom().primaryKey(),
  productionOrderId: uuid("production_order_id").references(() => productionOrders.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  plannedQuantity: integer("planned_quantity").notNull(),
  actualQuantity: integer("actual_quantity").notNull(),
  uomId: uuid("uom_id"),
  unitCost: integer("unit_cost").default(0),
  totalCost: integer("total_cost").default(0),
  batchNumber: text("batch_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orderIdx: index("idx_production_consumption_order").on(table.productionOrderId),
  entityIdx: index("idx_production_consumption_entity").on(table.entityId),
}));
