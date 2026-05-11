cube(`OrderLineItems`, {
  sql: `SELECT * FROM order_line_items`,

  measures: {
    count: { type: `count` },
    itemsSold: { sql: `quantity`, type: `sum` },
    lineItemRevenue: { sql: `total_price`, type: `sum` },
    averageUnitPrice: { sql: `unit_price`, type: `avg` },
  },

  dimensions: {
    entityType: { sql: `entity_type`, type: `string` },
    sku: { sql: `sku`, type: `string` },
    title: { sql: `title`, type: `string` },
    fulfillmentStatus: { sql: `fulfillment_status`, type: `string` },
  },
});
