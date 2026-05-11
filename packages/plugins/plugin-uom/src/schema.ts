import { pgTable, uuid, text, integer, boolean, timestamp, index, uniqueIndex } from "@porulle/core/drizzle";

export const unitsOfMeasure = pgTable("units_of_measure", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  category: text("category", { enum: ["weight", "volume", "length", "count", "area", "time"] }).notNull(),
  isBaseUnit: boolean("is_base_unit").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_uom_org").on(table.organizationId),
  codeUnique: uniqueIndex("uom_org_code_unique").on(table.organizationId, table.code),
}));

export const uomConversions = pgTable("uom_conversions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  fromUnitId: uuid("from_unit_id").references(() => unitsOfMeasure.id, { onDelete: "cascade" }).notNull(),
  toUnitId: uuid("to_unit_id").references(() => unitsOfMeasure.id, { onDelete: "cascade" }).notNull(),
  factor: integer("factor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_uom_conversions_org").on(table.organizationId),
}));

export const entityUom = pgTable("entity_uom", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  purchaseUomId: uuid("purchase_uom_id").references(() => unitsOfMeasure.id).notNull(),
  stockUomId: uuid("stock_uom_id").references(() => unitsOfMeasure.id).notNull(),
  saleUomId: uuid("sale_uom_id").references(() => unitsOfMeasure.id).notNull(),
  yieldPercentage: integer("yield_percentage").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  entityUnique: uniqueIndex("entity_uom_org_entity_unique").on(table.organizationId, table.entityId),
}));
