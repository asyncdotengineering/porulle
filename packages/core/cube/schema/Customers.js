cube(`Customers`, {
  sql: `SELECT * FROM customers`,

  measures: {
    customerCount: { type: `count` },
    newCustomers: { type: `count` },
    returningCustomers: {
      sql: `CASE WHEN (SELECT COUNT(*) FROM orders o WHERE o.customer_id = customers.user_id) > 1 THEN 1 ELSE 0 END`,
      type: `sum`,
    },
  },

  dimensions: {
    createdAt: { sql: `created_at`, type: `time` },
    customerGroup: { sql: `COALESCE(json_extract(metadata, '$.customerGroup'), 'default')`, type: `string` },
  },
});
