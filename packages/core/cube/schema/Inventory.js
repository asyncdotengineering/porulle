cube(`Inventory`, {
  sql: `SELECT * FROM inventory_levels`,

  measures: {
    totalOnHand: { sql: `quantity_on_hand`, type: `sum` },
    totalReserved: { sql: `quantity_reserved`, type: `sum` },
    totalAvailable: {
      sql: `quantity_on_hand - quantity_reserved`,
      type: `sum`,
    },
    inventoryValue: {
      sql: `quantity_on_hand * COALESCE(unit_cost, 0)`,
      type: `sum`,
    },
    lowStockCount: {
      sql: `CASE WHEN reorder_threshold IS NOT NULL AND (quantity_on_hand - quantity_reserved) <= reorder_threshold THEN 1 ELSE 0 END`,
      type: `sum`,
    },
  },

  dimensions: {
    entityId: { sql: `entity_id`, type: `string` },
    warehouseId: { sql: `warehouse_id`, type: `string` },
    lastRestockedAt: { sql: `last_restocked_at`, type: `time` },
  },
});
