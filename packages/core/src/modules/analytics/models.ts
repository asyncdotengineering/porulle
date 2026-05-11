import type { AnalyticsModel } from "./types.js";

/**
 * Built-in analytics model definitions for the 4 core tables.
 *
 * Each model maps semantic names (e.g., "Orders.revenue") to PostgreSQL
 * columns and aggregations. The DrizzleAnalyticsAdapter compiles these
 * into parameterized SQL queries at runtime.
 */

export const ORDERS_MODEL: AnalyticsModel = {
  name: "Orders",
  table: "orders",
  scopeRules: [
    { role: "vendor", filter: "id IN (SELECT order_id FROM marketplace_vendor_sub_orders WHERE vendor_id = :vendorId)" },
    { role: "customer", filter: "customer_id = :customerId" },
  ],
  measures: {
    count:             { type: "count" },
    revenue:           { sql: "grand_total", type: "sum" },
    averageOrderValue: { sql: "grand_total", type: "avg" },
    subtotalRevenue:   { sql: "subtotal", type: "sum" },
    taxCollected:      { sql: "tax_total", type: "sum" },
    shippingRevenue:   { sql: "shipping_total", type: "sum" },
    discountsGiven:    { sql: "discount_total", type: "sum" },
    uniqueCustomers:   { sql: "customer_id", type: "countDistinct" },
  },
  dimensions: {
    id:          { sql: "id", type: "string" },
    orderNumber: { sql: "order_number", type: "string" },
    status:      { sql: "status", type: "string" },
    currency:    { sql: "currency", type: "string" },
    placedAt:    { sql: "placed_at", type: "time" },
  },
};

export const ORDER_LINE_ITEMS_MODEL: AnalyticsModel = {
  name: "OrderLineItems",
  table: "order_line_items",
  scopeRules: [
    { role: "vendor", filter: "order_id IN (SELECT order_id FROM marketplace_vendor_sub_orders WHERE vendor_id = :vendorId)" },
    { role: "customer", filter: "order_id IN (SELECT id FROM orders WHERE customer_id = :customerId)" },
  ],
  joins: [
    {
      table: "orders",
      type: "left",
      on: "order_line_items.order_id = orders.id",
    },
  ],
  measures: {
    count:            { type: "count" },
    itemsSold:        { sql: "order_line_items.quantity", type: "sum" },
    lineItemRevenue:  { sql: "order_line_items.total_price", type: "sum" },
    averageUnitPrice: { sql: "order_line_items.unit_price", type: "avg" },
  },
  dimensions: {
    id:                { sql: "order_line_items.id", type: "string" },
    entityType:        { sql: "order_line_items.entity_type", type: "string" },
    sku:               { sql: "order_line_items.sku", type: "string" },
    title:             { sql: "order_line_items.title", type: "string" },
    fulfillmentStatus: { sql: "order_line_items.fulfillment_status", type: "string" },
  },
};

export const INVENTORY_MODEL: AnalyticsModel = {
  name: "Inventory",
  table: "inventory_levels",
  scopeRules: [
    { role: "vendor", filter: "entity_id IN (SELECT entity_id FROM marketplace_vendor_entities WHERE vendor_id = :vendorId)" },
  ],
  measures: {
    totalOnHand:    { sql: "quantity_on_hand", type: "sum" },
    totalReserved:  { sql: "quantity_reserved", type: "sum" },
    totalAvailable: { sql: "(quantity_on_hand - quantity_reserved)", type: "sum" },
    inventoryValue: { sql: "(quantity_on_hand * COALESCE(unit_cost, 0))", type: "sum" },
    lowStockCount:  {
      type: "count",
      filter: "reorder_threshold IS NOT NULL AND (quantity_on_hand - quantity_reserved) <= reorder_threshold",
    },
  },
  dimensions: {
    entityId:        { sql: "entity_id", type: "string" },
    warehouseId:     { sql: "warehouse_id", type: "string" },
    lastRestockedAt: { sql: "last_restocked_at", type: "time" },
  },
  segments: {
    lowStock: {
      sql: "reorder_threshold IS NOT NULL AND (quantity_on_hand - quantity_reserved) <= reorder_threshold",
    },
  },
};

export const CUSTOMERS_MODEL: AnalyticsModel = {
  name: "Customers",
  table: "customers",
  scopeRules: [
    { role: "vendor", filter: "id IN (SELECT DISTINCT customer_id FROM orders WHERE id IN (SELECT order_id FROM marketplace_vendor_sub_orders WHERE vendor_id = :vendorId) AND customer_id IS NOT NULL)" },
    { role: "customer", filter: "id = :customerId" },
  ],
  measures: {
    customerCount:      { type: "count" },
    newCustomers:       { type: "count" },
    returningCustomers: {
      type: "count",
      filter: "(SELECT COUNT(*) FROM orders WHERE orders.customer_id = customers.id) > 1",
    },
  },
  dimensions: {
    createdAt:     { sql: "created_at", type: "time" },
    customerGroup: { sql: "COALESCE(metadata->>'customerGroup', 'default')", type: "string" },
  },
  segments: {
    returning: {
      sql: "(SELECT COUNT(*) FROM orders WHERE orders.customer_id = customers.id) > 1",
    },
  },
};

export const BUILTIN_ANALYTICS_MODELS: AnalyticsModel[] = [
  ORDERS_MODEL,
  ORDER_LINE_ITEMS_MODEL,
  INVENTORY_MODEL,
  CUSTOMERS_MODEL,
];
