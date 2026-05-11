cube(`Orders`, {
  sql: `SELECT * FROM orders`,

  measures: {
    count: { type: `count` },
    revenue: { sql: `grand_total`, type: `sum` },
    averageOrderValue: { sql: `grand_total`, type: `avg` },
    subtotalRevenue: { sql: `subtotal`, type: `sum` },
    taxCollected: { sql: `tax_total`, type: `sum` },
    shippingRevenue: { sql: `shipping_total`, type: `sum` },
    discountsGiven: { sql: `discount_total`, type: `sum` },
    uniqueCustomers: { sql: `customer_id`, type: `countDistinct` },
  },

  dimensions: {
    id: { sql: `id`, type: `string`, primaryKey: true },
    orderNumber: { sql: `order_number`, type: `string` },
    status: { sql: `status`, type: `string` },
    currency: { sql: `currency`, type: `string` },
    placedAt: { sql: `placed_at`, type: `time` },
  },

  preAggregations: {
    dailyRevenue: {
      type: `rollup`,
      measures: [Orders.revenue, Orders.count],
      timeDimension: Orders.placedAt,
      granularity: `day`,
      refreshKey: {
        every: `1 hour`,
      },
    },
  },
});
