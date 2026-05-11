/**
 * POS Restaurant Extension Schema
 *
 * 8 tables extending the POS Tier 0 plugin for restaurant operations:
 *
 * Modifiers:
 * - pos_modifier_groups: modifier group definitions (required/optional, min/max)
 * - pos_modifier_options: individual options within a group (name, price adjustment)
 *
 * Tables:
 * - pos_tables: physical table registry (zone, capacity, shape, floor plan layout)
 * - pos_table_assignments: links tables to active POS transactions
 *
 * KDS (Kitchen Display System):
 * - kds_stations: kitchen section definitions (item group routing)
 * - kds_station_item_groups: maps item groups to stations for ticket routing
 * - kds_tickets: kitchen tickets routed to stations (status: pending -> preparing -> ready -> served)
 * - kds_ticket_items: individual items within a ticket (course priority, modifiers, item-level status)
 *
 * Informed by URY Restaurant ERP production patterns:
 * - URY Table (room-based, occupied flag, floor plan layout_x/y, shape, is_take_away)
 * - URY Production Unit (item-group routing, per-station printers)
 * - URY KOT (type enum, order_status, production_time, course serving priority)
 * - URY Menu Course (custom_serving_priority, custom_indicate_in_kds)
 */

import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from "@porulle/core/drizzle";

// ─── Modifier Groups ───────────────────────────────────────────────────
// URY equivalent: Item Add On (flat item links) — we add structured grouping,
// required/optional, min/max constraints, and price adjustments.

export const posModifierGroups = pgTable("pos_modifier_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  entityId: uuid("entity_id"),
  itemGroup: text("item_group"),
  isRequired: boolean("is_required").notNull().default(false),
  minSelect: integer("min_select").notNull().default(0),
  maxSelect: integer("max_select").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_modifier_groups_org").on(table.organizationId),
  entityIdx: index("idx_pos_modifier_groups_entity").on(table.entityId),
  nameUnique: uniqueIndex("pos_modifier_groups_org_name_entity_unique")
    .on(table.organizationId, table.name, table.entityId),
}));

// ─── Modifier Options ──────────────────────────────────────────────────
// Individual choices within a modifier group. Each option can carry a price
// adjustment (surcharge or discount). URY had no pricing on modifiers.

export const posModifierOptions = pgTable("pos_modifier_options", {
  id: uuid("id").defaultRandom().primaryKey(),
  groupId: uuid("group_id").references(() => posModifierGroups.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  priceAdjustment: integer("price_adjustment").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
  isAvailable: boolean("is_available").notNull().default(true),
  entityId: uuid("entity_id"),              // optional: links to inventory entity for deduction
  inventoryQuantity: integer("inventory_quantity").notNull().default(0), // amount to deduct per application
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  groupIdx: index("idx_pos_modifier_options_group").on(table.groupId),
}));

// ─── Tables ─────────────────────────────────────────────────────────────
// URY equivalent: URY Table with restaurant_room, no_of_seats, table_shape,
// layout_x/y, is_take_away, occupied (binary). We improve with a 4-state
// status machine and assignedOperatorId for server sections.

export const posTables = pgTable("pos_tables", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  number: text("number").notNull(),
  zone: text("zone").notNull(),
  capacity: integer("capacity").notNull().default(4),
  minimumSeats: integer("minimum_seats").notNull().default(1),
  shape: text("shape", { enum: ["rectangle", "square", "circle"] }).notNull().default("rectangle"),
  status: text("status", { enum: ["available", "occupied", "bill_requested", "cleaning"] }).notNull().default("available"),
  isTakeaway: boolean("is_takeaway").notNull().default(false),
  assignedOperatorId: text("assigned_operator_id"),
  layoutX: integer("layout_x").notNull().default(0),
  layoutY: integer("layout_y").notNull().default(0),
  layoutWidth: integer("layout_width").notNull().default(100),
  layoutHeight: integer("layout_height").notNull().default(100),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_tables_org").on(table.organizationId),
  numberUnique: uniqueIndex("pos_tables_org_number_unique").on(table.organizationId, table.number),
  zoneIdx: index("idx_pos_tables_zone").on(table.zone),
  statusIdx: index("idx_pos_tables_status").on(table.status),
}));

// ─── Table Assignments ──────────────────────────────────────────────────
// Links tables to active POS transactions. Supports multi-table seating
// (large party across 2+ tables). URY stored this as a single FK on POS Invoice.

export const posTableAssignments = pgTable("pos_table_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tableId: uuid("table_id").references(() => posTables.id, { onDelete: "cascade" }).notNull(),
  transactionId: uuid("transaction_id").notNull(),
  seatedAt: timestamp("seated_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  tableIdx: index("idx_pos_table_assignments_table").on(table.tableId),
  transactionIdx: index("idx_pos_table_assignments_transaction").on(table.transactionId),
}));

// ─── KDS Stations ───────────────────────────────────────────────────────
// URY equivalent: URY Production Unit. Represents a kitchen section/station
// that receives tickets for items matching its assigned item groups.

export const kdsStations = pgTable("kds_stations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  alertThresholdMinutes: integer("alert_threshold_minutes").notNull().default(15),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_kds_stations_org").on(table.organizationId),
  nameUnique: uniqueIndex("kds_stations_org_name_unique").on(table.organizationId, table.name),
}));

// ─── KDS Station Item Groups ────────────────────────────────────────────
// URY equivalent: URY Production Item Groups. Maps item categories to
// stations for routing. When a POS transaction adds a "mains" item,
// the system routes it to the station that has "mains" in its item groups.

export const kdsStationItemGroups = pgTable("kds_station_item_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  stationId: uuid("station_id").references(() => kdsStations.id, { onDelete: "cascade" }).notNull(),
  itemGroup: text("item_group").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  stationIdx: index("idx_kds_station_item_groups_station").on(table.stationId),
}));

// ─── KDS Tickets ────────────────────────────────────────────────────────
// URY equivalent: URY KOT. A kitchen ticket routed to a specific station.
// One POS transaction may generate multiple tickets (one per station with
// matching items). URY's order_status was "Ready For Prepare" -> "Served";
// we add "preparing" and "ready" for finer-grained kitchen tracking.

export const kdsTickets = pgTable("kds_tickets", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  transactionId: uuid("transaction_id").notNull(),
  stationId: uuid("station_id").references(() => kdsStations.id).notNull(),
  orderId: uuid("order_id"),
  type: text("type", { enum: ["new_order", "modified", "cancelled", "partially_cancelled"] }).notNull().default("new_order"),
  status: text("status", { enum: ["pending", "preparing", "ready", "served"] }).notNull().default("pending"),
  tableNumber: text("table_number"),
  orderType: text("order_type", { enum: ["dine_in", "takeaway", "delivery"] }).notNull().default("dine_in"),
  operatorName: text("operator_name"),
  ticketNumber: text("ticket_number").notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  servedAt: timestamp("served_at", { withTimezone: true }),
  prepDurationSeconds: integer("prep_duration_seconds"),
  comments: text("comments"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_kds_tickets_org").on(table.organizationId),
  stationStatusIdx: index("idx_kds_tickets_station_status").on(table.stationId, table.status),
  transactionIdx: index("idx_kds_tickets_transaction").on(table.transactionId),
}));

// ─── KDS Ticket Items ───────────────────────────────────────────────────
// URY equivalent: URY KOT Items. Individual items within a ticket.
// URY stored item strikethrough in browser localStorage only — we persist
// item-level status to the database. Course priority (URY: custom_serving_priority)
// and course label display (URY: custom_indicate_in_kds) are first-class fields.

export const kdsTicketItems = pgTable("kds_ticket_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  ticketId: uuid("ticket_id").references(() => kdsTickets.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  itemName: text("item_name").notNull(),
  quantity: integer("quantity").notNull(),
  cancelledQuantity: integer("cancelled_quantity").notNull().default(0),
  courseName: text("course_name"),
  coursePriority: integer("course_priority").notNull().default(0),
  showCourseLabel: boolean("show_course_label").notNull().default(false),
  status: text("status", { enum: ["pending", "preparing", "done"] }).notNull().default("pending"),
  modifiers: jsonb("modifiers").$type<Array<{ name: string; priceAdjustment: number }>>().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  ticketIdx: index("idx_kds_ticket_items_ticket").on(table.ticketId),
}));

// ═══════════════════════════════════════════════════════════════════════
// OPERATIONAL FEATURES — Checklists, Alerts, Menu Availability
// ═══════════════════════════════════════════════════════════════════════

// ─── Pre-Billing Checklists ─────────────────────────────────────────────
// URY: Pre-billing checklists to enforce compliance (stock check, hygiene).
// Configurable checklists that must be completed before a bill can be printed.

export const posChecklists = pgTable("pos_checklists", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  type: text("type", { enum: ["pre_billing", "shift_open", "shift_close"] }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_checklists_org").on(table.organizationId),
}));

export const posChecklistItems = pgTable("pos_checklist_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  checklistId: uuid("checklist_id").references(() => posChecklists.id, { onDelete: "cascade" }).notNull(),
  label: text("label").notNull(),
  isRequired: boolean("is_required").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  checklistIdx: index("idx_pos_checklist_items_checklist").on(table.checklistId),
}));

// ─── Checklist Completions ──────────────────────────────────────────────
// Records when an operator completes a checklist for a transaction or shift.

export const posChecklistCompletions = pgTable("pos_checklist_completions", {
  id: uuid("id").defaultRandom().primaryKey(),
  checklistId: uuid("checklist_id").references(() => posChecklists.id).notNull(),
  referenceType: text("reference_type", { enum: ["transaction", "shift"] }).notNull(),
  referenceId: uuid("reference_id").notNull(),
  operatorId: text("operator_id").notNull(),
  completedItems: jsonb("completed_items").$type<Array<{ itemId: string; checked: boolean; note?: string }>>().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  referenceIdx: index("idx_pos_checklist_completions_ref").on(table.referenceType, table.referenceId),
}));

// ─── Operational Alerts ─────────────────────────────────────────────────
// URY: Red flags for delayed orders, unclosed bills, excessive cancellations,
// prolonged table occupancy. Real-time alerts for operational exceptions.

export const posRestaurantAlerts = pgTable("pos_restaurant_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  type: text("type", {
    enum: [
      "delayed_order",
      "kot_not_started",
      "unclosed_bill",
      "prolonged_occupancy",
      "excessive_cancellations",
      "excessive_modifications",
    ],
  }).notNull(),
  severity: text("severity", { enum: ["warning", "critical"] }).notNull().default("warning"),
  referenceType: text("reference_type").notNull(),
  referenceId: text("reference_id").notNull(),
  message: text("message").notNull(),
  isResolved: boolean("is_resolved").notNull().default(false),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_restaurant_alerts_org").on(table.organizationId),
  typeIdx: index("idx_pos_restaurant_alerts_type").on(table.type),
  unresolvedIdx: index("idx_pos_restaurant_alerts_unresolved").on(table.organizationId, table.isResolved),
}));

// ─── Alert Configuration ────────────────────────────────────────────────
// Thresholds for each alert type per organization.

export const posAlertConfig = pgTable("pos_alert_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  alertType: text("alert_type").notNull(),
  thresholdMinutes: integer("threshold_minutes").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  notifyRoles: jsonb("notify_roles").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgTypeUnique: uniqueIndex("pos_alert_config_org_type_unique").on(table.organizationId, table.alertType),
}));

// ═══════════════════════════════════════════════════════════════════════
// MENU & RECIPE MANAGEMENT — Combos, BOM, Availability
// ═══════════════════════════════════════════════════════════════════════

// ─── Recipes (Bill of Materials) ────────────────────────────────────────
// URY: Recipe mapping using BOM. Links menu items to raw ingredients
// for COGS calculation in P&L.

export const posRecipes = pgTable("pos_recipes", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  name: text("name").notNull(),
  yieldQuantity: integer("yield_quantity").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_recipes_org").on(table.organizationId),
  entityIdx: index("idx_pos_recipes_entity").on(table.entityId),
}));

export const posRecipeIngredients = pgTable("pos_recipe_ingredients", {
  id: uuid("id").defaultRandom().primaryKey(),
  recipeId: uuid("recipe_id").references(() => posRecipes.id, { onDelete: "cascade" }).notNull(),
  ingredientName: text("ingredient_name").notNull(),
  quantity: integer("quantity").notNull(),
  unit: text("unit").notNull().default("g"),
  costPerUnit: integer("cost_per_unit").notNull().default(0),
  entityId: uuid("entity_id"),       // optional: links ingredient to inventory entity for deduction
  variantId: uuid("variant_id"),     // optional: specific variant to deduct
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  recipeIdx: index("idx_pos_recipe_ingredients_recipe").on(table.recipeId),
}));

// ─── Combos / Meal Deals ────────────────────────────────────────────────
// URY: Supports combos, modifiers, and item bundles.
// A combo has groups (e.g., "Choose your drink", "Choose your side")
// and a fixed bundle price.

export const posCombos = pgTable("pos_combos", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  entityId: uuid("entity_id").notNull(),
  price: integer("price").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_pos_combos_org").on(table.organizationId),
  entityIdx: index("idx_pos_combos_entity").on(table.entityId),
}));

export const posComboGroups = pgTable("pos_combo_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  comboId: uuid("combo_id").references(() => posCombos.id, { onDelete: "cascade" }).notNull(),
  name: text("name").notNull(),
  minSelect: integer("min_select").notNull().default(1),
  maxSelect: integer("max_select").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  comboIdx: index("idx_pos_combo_groups_combo").on(table.comboId),
}));

export const posComboItems = pgTable("pos_combo_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  groupId: uuid("group_id").references(() => posComboGroups.id, { onDelete: "cascade" }).notNull(),
  entityId: uuid("entity_id").notNull(),
  itemName: text("item_name").notNull(),
  priceAdjustment: integer("price_adjustment").notNull().default(0),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  groupIdx: index("idx_pos_combo_items_group").on(table.groupId),
}));

// ─── Menu Availability ──────────────────────────────────────────────────
// URY: Control pricing, availability, and portions per outlet.
// URY Menu Item has a `disabled` checkbox per item.

export const posMenuAvailability = pgTable("pos_menu_availability", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  isAvailable: boolean("is_available").notNull().default(true),
  unavailableReason: text("unavailable_reason"),
  unavailableSince: timestamp("unavailable_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgEntityUnique: uniqueIndex("pos_menu_availability_org_entity_unique").on(table.organizationId, table.entityId),
}));

// ═══════════════════════════════════════════════════════════════════════
// ANALYTICS — Daily P&L, Performance Tracking
// ═══════════════════════════════════════════════════════════════════════

// ─── Daily Profit & Loss ────────────────────────────────────────────────
// URY: URY Daily P&L doctype. Calculates gross sales, COGS, direct expenses,
// indirect expenses, employee costs, and net profit for each day.

export const posDailyPnl = pgTable("pos_daily_pnl", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  date: timestamp("date", { withTimezone: true }).notNull(),
  grossSales: integer("gross_sales").notNull().default(0),
  netSales: integer("net_sales").notNull().default(0),
  costOfGoods: integer("cost_of_goods").notNull().default(0),
  directExpenses: integer("direct_expenses").notNull().default(0),
  indirectExpenses: integer("indirect_expenses").notNull().default(0),
  employeeCosts: integer("employee_costs").notNull().default(0),
  grossProfit: integer("gross_profit").notNull().default(0),
  netProfit: integer("net_profit").notNull().default(0),
  transactionCount: integer("transaction_count").notNull().default(0),
  averageBillValue: integer("average_bill_value").notNull().default(0),
  status: text("status", { enum: ["draft", "submitted"] }).notNull().default("draft"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgDateUnique: uniqueIndex("pos_daily_pnl_org_date_unique").on(table.organizationId, table.date),
}));

// ─── P&L Expense Line Items ─────────────────────────────────────────────
// Breakdown of expenses for a daily P&L record.

export const posPnlExpenses = pgTable("pos_pnl_expenses", {
  id: uuid("id").defaultRandom().primaryKey(),
  pnlId: uuid("pnl_id").references(() => posDailyPnl.id, { onDelete: "cascade" }).notNull(),
  category: text("category", { enum: ["cogs", "direct", "indirect", "employee"] }).notNull(),
  name: text("name").notNull(),
  amount: integer("amount").notNull(),
  percentage: integer("percentage"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pnlIdx: index("idx_pos_pnl_expenses_pnl").on(table.pnlId),
}));

// ─── Customer Favorites ─────────────────────────────────────────────────
// URY: For returning customers, displays their top 3 ordered items.
// Materialized view of customer order history for fast POS lookup.

export const posCustomerFavorites = pgTable("pos_customer_favorites", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  customerId: uuid("customer_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  itemName: text("item_name").notNull(),
  orderCount: integer("order_count").notNull().default(1),
  lastOrderedAt: timestamp("last_ordered_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  customerIdx: index("idx_pos_customer_favorites_customer").on(table.organizationId, table.customerId),
  orgCustomerEntityUnique: uniqueIndex("pos_customer_favorites_unique").on(table.organizationId, table.customerId, table.entityId),
}));
