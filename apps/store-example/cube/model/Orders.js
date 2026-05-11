cube(`Orders`, {
  sql_table: `orders`,

  measures: {
    count: { type: `count` },
    revenue: { sql: `grand_total`, type: `sum` },
    averageOrderValue: { sql: `grand_total`, type: `avg` },
    subtotalRevenue: { sql: `subtotal`, type: `sum` },
    taxCollected: { sql: `tax_total`, type: `sum` },
    shippingRevenue: { sql: `shipping_total`, type: `sum` },
    discountsGiven: { sql: `discount_total`, type: `sum` },
    uniqueCustomers: { sql: `customer_id`, type: `count_distinct` },
  },

  dimensions: {
    id: { sql: `id`, type: `string`, primary_key: true },
    orderNumber: { sql: `order_number`, type: `string` },
    status: { sql: `status`, type: `string` },
    currency: { sql: `currency`, type: `string` },
    placedAt: { sql: `placed_at`, type: `time` },
  },
});