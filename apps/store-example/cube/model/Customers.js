cube(`Customers`, {
  sql_table: `customers`,

  measures: {
    customerCount: { type: `count` },
    newCustomers: { type: `count` },
    returningCustomers: { type: `count`, filters: [{ sql: `(SELECT COUNT(*) FROM orders WHERE orders.customer_id = id) > 1` }] },
  },

  dimensions: {
    createdAt: { sql: `created_at`, type: `time` },
    customerGroup: { sql: `COALESCE(metadata->>'customerGroup', 'default')`, type: `string` },
  },

  segments: {
    returning: { sql: `(SELECT COUNT(*) FROM orders WHERE orders.customer_id = customers.id) > 1` },
  },
});