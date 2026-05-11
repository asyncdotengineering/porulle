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
} from "drizzle-orm/pg-core";
import { organization } from "../../auth/auth-schema.js";
import { sellableEntities, variants } from "../catalog/schema.js";

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    address: jsonb("address").$type<Record<string, unknown>>(),
    isActive: boolean("is_active").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  },
  (table) => ({
    orgIdx: index("idx_warehouses_org").on(table.organizationId),
    orgCodeUnique: uniqueIndex("warehouses_org_code_unique").on(table.organizationId, table.code),
  }),
);

export const inventoryLevels = pgTable(
  "inventory_levels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .references(() => sellableEntities.id, { onDelete: "cascade" })
      .notNull(),
    variantId: uuid("variant_id").references(() => variants.id, {
      onDelete: "cascade",
    }),
    warehouseId: uuid("warehouse_id")
      .references(() => warehouses.id)
      .notNull(),
    quantityOnHand: integer("quantity_on_hand").notNull().default(0),
    quantityReserved: integer("quantity_reserved").notNull().default(0),
    quantityIncoming: integer("quantity_incoming").notNull().default(0),
    unitCost: integer("unit_cost"),
    reorderThreshold: integer("reorder_threshold"),
    reorderQuantity: integer("reorder_quantity"),
    version: integer("version").notNull().default(0),
    lastRestockedAt: timestamp("last_restocked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_inventory_levels_org").on(table.organizationId),
    entityVariantWarehouseIdx: index("idx_inventory_entity_variant_warehouse").on(
      table.entityId,
      table.variantId,
      table.warehouseId,
    ),
  }),
);

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .references(() => sellableEntities.id)
      .notNull(),
    variantId: uuid("variant_id").references(() => variants.id),
    warehouseId: uuid("warehouse_id")
      .references(() => warehouses.id)
      .notNull(),
    type: text("type", {
      enum: [
        "receipt",
        "sale",
        "return",
        "adjustment",
        "transfer",
        "reservation",
        "release",
        "fulfillment",
      ],
    }).notNull(),
    quantity: integer("quantity").notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    reason: text("reason"),
    performedBy: text("performed_by").notNull(),
    performedAt: timestamp("performed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index("idx_inventory_movements_org").on(table.organizationId),
  }),
);
