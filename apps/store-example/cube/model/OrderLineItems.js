cube(`OrderLineItems`, {
  sql_table: `order_line_items`,

  joins: {
    Orders: {
      relationship: `many_to_one`,
      sql: `${CUBE}.order_id = ${Orders}.id`,
    },
  },

  measures: {
    count: { type: `count` },
    itemsSold: { sql: `quantity`, type: `sum` },
    lineItemRevenue: { sql: `total_price`, type: `sum` },
    averageUnitPrice: { sql: `unit_price`, type: `avg` },
  },

  dimensions: {
    id: { sql: `id`, type: `string`, primary_key: true },
    entityType: { sql: `entity_type`, type: `string` },
    sku: { sql: `sku`, type: `string` },
    title: { sql: `title`, type: `string` },
    fulfillmentStatus: { sql: `fulfillment_status`, type: `string` },
  },
});