cube(`Inventory`, {
  sql_table: `inventory_levels`,

  measures: {
    totalOnHand: { sql: `quantity_on_hand`, type: `sum` },
    totalReserved: { sql: `quantity_reserved`, type: `sum` },
    totalAvailable: { sql: `(quantity_on_hand - quantity_reserved)`, type: `sum` },
    inventoryValue: { sql: `(quantity_on_hand * COALESCE(unit_cost, 0))`, type: `sum` },
    lowStockCount: { type: `count`, filters: [{ sql: `reorder_threshold IS NOT NULL AND (quantity_on_hand - quantity_reserved) <= reorder_threshold` }] },
  },

  dimensions: {
    entityId: { sql: `entity_id`, type: `string` },
    warehouseId: { sql: `warehouse_id`, type: `string` },
    lastRestockedAt: { sql: `last_restocked_at`, type: `time` },
  },

  segments: {
    lowStock: { sql: `reorder_threshold IS NOT NULL AND (quantity_on_hand - quantity_reserved) <= reorder_threshold` },
  },
});