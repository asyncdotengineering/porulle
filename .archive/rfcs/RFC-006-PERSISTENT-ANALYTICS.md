# RFC-006: Persistent Analytics — Replace In-Memory Query Engine with Cube.js Semantic Layer

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-14
- **Scope:** `packages/core/src/modules/analytics/`
- **Depends on:** RFC-005 (event wiring — deferred, can implement independently)
- **Estimated effort:** 5–7 days

---

## 1. Summary

The analytics module has a Cube.js-shaped API (measures, dimensions, timeDimensions, filters) but runs on a bespoke in-memory query engine. Every `query()` call fetches ALL rows from the source tables (orders, inventory, customers), loads them into memory, and performs JavaScript `.filter()` / `.reduce()` / `.map()` to compute aggregates. Analytics events are stored in an in-memory array and lost on server restart.

This RFC replaces the in-memory engine with a proper persistence layer and evaluates two approaches: a lightweight SQL-based query engine (keep ownership, persist events to a table, use PostgreSQL aggregations), and a Cube.js integration (delegate to a proven semantic layer that already speaks the same API shape).

---

## 2. Current State

### What exists

The `AnalyticsService` implements the Cube.js query protocol:

```typescript
// The query API already matches Cube.js conventions
analytics.query({
  measures: ["Orders.revenue"],
  dimensions: ["Orders.status"],
  timeDimensions: [{
    dimension: "Orders.placedAt",
    granularity: "month",
    dateRange: ["2026-01-01", "2026-03-31"],
  }],
  filters: [{ member: "Orders.status", operator: "equals", values: ["confirmed"] }],
  order: { "Orders.revenue": "desc" },
  limit: 10,
});
```

### How it works internally

```
analytics.query(params)
  → pickCube("Orders")                              // which "cube" (table) to query
  → getCubeRecords("Orders")                         // fetch ALL rows from orders table
  → ordersRepository.findAll()                       // SELECT * FROM orders (no WHERE, no LIMIT)
  → load entire table into JavaScript array
  → applyFilters(rows, params)                       // JS .filter() on every row
  → groupRows(filtered, params, cube)                // JS .reduce() for GROUP BY
  → computeMeasures(groups, params)                  // JS .reduce() for SUM/COUNT/AVG
  → return { rows, meta }
```

### Why this is a problem

1. **Memory explosion.** At 200 orders/day, after 1 year = 73,000 orders. `findAll()` loads all 73K rows + their line items into a JavaScript array on every dashboard load. At ~2KB per order, that's ~150MB of memory per query.

2. **No indexes.** PostgreSQL has indexes on `orders.status`, `orders.placed_at`, `orders.customer_id`. The in-memory engine ignores all of them — it does a full table scan via `SELECT *`, then filters in JavaScript.

3. **Ephemeral analytics events.** The `recordEvent()` method pushes to `this.analyticsEvents: AnalyticsEvent[] = []`. Server restart = all event history gone. The `getEventCount()` method returns 0 after restart.

4. **No pre-aggregations.** Every query recomputes aggregates from raw data. A "revenue by month for the last 12 months" query loads ALL orders, then groups and sums in JavaScript. PostgreSQL can do this with a single indexed `GROUP BY` query in milliseconds.

5. **Plugin models are dummy-only.** Marketplace and POS plugins register models (e.g., `MarketplaceSubOrders.subtotal`), but the query engine returns 0 for any model it doesn't have a hardcoded `getCubeRecords()` handler for.

---

## 3. The Two Approaches

### Approach A: SQL-Based Query Engine (Keep Ownership)

Replace the in-memory `.filter()` / `.reduce()` with generated SQL queries against PostgreSQL.

**How it works:**

```
analytics.query(params)
  → buildSQL(params)                               // generate SELECT with GROUP BY, WHERE, etc.
  → db.execute(sql)                                 // single PostgreSQL query with indexes
  → return { rows, meta }
```

The `buildSQL()` function translates the Cube.js-shaped params into SQL:

```sql
-- analytics.query({ measures: ["Orders.revenue"], timeDimensions: [{ dimension: "Orders.placedAt", granularity: "month" }] })
SELECT
  DATE_TRUNC('month', placed_at) AS "Orders.placedAt",
  SUM(grand_total) AS "Orders.revenue"
FROM orders
WHERE placed_at >= '2026-01-01' AND placed_at < '2026-04-01'
GROUP BY DATE_TRUNC('month', placed_at)
ORDER BY "Orders.placedAt" ASC;
```

**Pros:**
- Full control, no external dependency
- Single PostgreSQL instance — no additional infrastructure
- Existing Drizzle ORM can generate queries
- Works with PGlite in tests

**Cons:**
- Must build and maintain a query-to-SQL compiler
- No pre-aggregation caching (every query hits raw tables)
- No built-in dashboard/visualization layer
- Must manually define SQL mappings for every measure/dimension
- Plugin-registered models need custom SQL generation per model

**Estimated effort:** 3–4 days

### Approach B: Cube.js Integration (Delegate to Semantic Layer)

Use Cube.js as the analytics engine. The current API already speaks the Cube.js query protocol — the migration is mostly configuration.

**How it works:**

Cube.js connects directly to the same PostgreSQL database and runs its own SQL queries with:
- Pre-aggregation tables (materialized views) for fast repeated queries
- Automatic query optimization and caching
- Built-in support for joins across cubes
- REST API, GraphQL API, and SQL API out of the box

**Integration modes:**

1. **Embedded mode** — Cube.js runs inside the Node.js process via `@cubejs-backend/server-core`. No separate service. The `AnalyticsService.query()` method delegates to the Cube.js API internally.

2. **Sidecar mode** — Cube.js runs as a separate process/container alongside the commerce engine. The `AnalyticsService.query()` method calls the Cube.js REST API over HTTP.

3. **Adapter mode** — Define an `AnalyticsAdapter` interface (like `PaymentAdapter`, `SearchAdapter`). The Cube.js adapter implements it. A built-in `DrizzleAnalyticsAdapter` provides the SQL approach (Approach A) as a fallback for developers who don't want Cube.js.

**Cube.js data models:**

The current `AnalyticsService` already defines measures and dimensions in the Cube.js naming convention. These translate directly to Cube.js model files:

```javascript
// model/Orders.js
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

  pre_aggregations: {
    dailyRevenue: {
      measures: [CUBE.revenue, CUBE.count],
      time_dimension: CUBE.placedAt,
      granularity: `day`,
      refresh_key: { every: `1 hour` },
    },
  },
});
```

```javascript
// model/Inventory.js
cube(`Inventory`, {
  sql_table: `inventory_levels`,

  measures: {
    totalOnHand: { sql: `quantity_on_hand`, type: `sum` },
    totalReserved: { sql: `quantity_reserved`, type: `sum` },
    totalAvailable: { sql: `quantity_on_hand - quantity_reserved`, type: `sum` },
    inventoryValue: { sql: `quantity_on_hand * COALESCE(unit_cost, 0)`, type: `sum` },
    lowStockCount: {
      type: `count`,
      filters: [{
        sql: `quantity_on_hand - quantity_reserved <= COALESCE(reorder_threshold, 0)`
      }],
    },
  },

  dimensions: {
    entityId: { sql: `entity_id`, type: `string` },
    warehouseId: { sql: `warehouse_id`, type: `string` },
    lastRestockedAt: { sql: `last_restocked_at`, type: `time` },
  },
});
```

```javascript
// model/MarketplaceSubOrders.js (plugin-contributed)
cube(`MarketplaceSubOrders`, {
  sql_table: `marketplace_vendor_sub_orders`,

  measures: {
    subtotal: { sql: `subtotal`, type: `sum` },
    commissionAmount: { sql: `commission_amount`, type: `sum` },
    payoutAmount: { sql: `payout_amount`, type: `sum` },
    count: { type: `count` },
  },

  dimensions: {
    vendorId: { sql: `vendor_id`, type: `string` },
    status: { sql: `status`, type: `string` },
    createdAt: { sql: `created_at`, type: `time` },
  },
});
```

**Pros:**
- Production-proven at scale (Cube.js powers analytics for companies processing millions of rows)
- Pre-aggregation caching — repeated queries hit materialized views, not raw tables
- Plugin-registered models work automatically — just generate a `.js` model file
- Built-in REST/GraphQL/SQL APIs — can expose analytics directly without routing through the engine
- The current API already speaks Cube.js — migration is swapping the backend, not the API
- Cube.js handles query optimization, join planning, and caching

**Cons:**
- External dependency (`@cubejs-backend/server-core` is ~50MB)
- Embedded mode adds memory overhead (~100-200MB for the Cube.js runtime)
- Sidecar mode adds operational complexity (another process to manage)
- Pre-aggregation tables consume disk space (trade space for speed)
- Learning curve for Cube.js data modeling (though our models are already defined)
- PGlite compatibility unknown for embedded mode (may need sidecar for tests)

**Estimated effort:** 5–7 days

---

## 4. Recommendation: Adapter Pattern (Both)

Follow the framework's ethos: define an `AnalyticsAdapter` interface, provide two implementations.

```typescript
export interface AnalyticsAdapter {
  query(params: AnalyticsQueryParams): Promise<Result<AnalyticsQueryResult>>;
  getMeta(): Promise<Result<AnalyticsMeta>>;
}
```

### Built-in: `DrizzleAnalyticsAdapter`

- Translates Cube.js-shaped queries to SQL via Drizzle
- No external dependencies
- Works with PGlite in tests
- Suitable for small-to-medium deployments (<100K orders)
- Default adapter — works out of the box

### Optional: `CubeJsAnalyticsAdapter`

- Delegates to Cube.js (embedded or sidecar)
- Pre-aggregation caching for fast repeated queries
- Scales to millions of rows
- Plugin models auto-generated as Cube.js model files
- Recommended for production marketplaces with >10K orders/month

### Configuration

```typescript
// Small store — built-in SQL engine (default, no config needed)
defineConfig({
  analytics: {
    // adapter defaults to DrizzleAnalyticsAdapter
  },
});

// Growing marketplace — Cube.js for pre-aggregations
import { cubeJsAnalyticsAdapter } from "@unifiedcommerce/adapter-cubejs";

defineConfig({
  analytics: {
    adapter: cubeJsAnalyticsAdapter({
      databaseUrl: process.env.DATABASE_URL,
      // Pre-aggregation refresh interval
      refreshInterval: "1 hour",
      // Optional: path to custom Cube.js model files
      modelPath: "./cube/models",
    }),
  },
});
```

---

## 5. Analytics Events Persistence

Regardless of which adapter is used, analytics events need to survive server restarts.

### Current (broken)

```typescript
private analyticsEvents: AnalyticsEvent[] = [];
recordEvent(event) { this.analyticsEvents.push(event); } // lost on restart
```

### Proposed

**Option A (with DrizzleAnalyticsAdapter):** Events are not needed as a separate concept. The adapter queries raw tables (orders, inventory) directly. The `recordEvent` hook becomes unnecessary — the data IS the event. Remove the in-memory array entirely.

**Option B (with CubeJsAnalyticsAdapter):** Cube.js reads directly from PostgreSQL tables. Events are the rows in `orders`, `inventory_levels`, etc. Pre-aggregation tables cache the aggregates. No separate event persistence needed.

**In both cases:** The "analytics events" abstraction was only needed because the in-memory engine couldn't query the database efficiently. With either SQL-based or Cube.js-based analytics, the source-of-truth IS the existing tables. The in-memory event array becomes dead code and should be removed.

The `getEventCount()` method (used in 2 tests) can be replaced with `SELECT COUNT(*) FROM orders WHERE placed_at > $lastRestart`.

---

## 6. Plugin Model Registration

### Current

Plugins register models via `analyticsModels()`:

```typescript
// plugin-marketplace
analyticsModels: () => [
  {
    name: "MarketplaceSubOrders",
    measures: ["MarketplaceSubOrders.subtotal", "MarketplaceSubOrders.commissionAmount"],
    dimensions: ["MarketplaceSubOrders.vendorId", "MarketplaceSubOrders.status"],
  },
]
```

These are collected into `config.analytics.models` but the query engine returns 0 for any model without a hardcoded `getCubeRecords()` handler.

### With DrizzleAnalyticsAdapter

Plugin models need a `sql_table` mapping. Extend the model definition:

```typescript
{
  name: "MarketplaceSubOrders",
  table: "marketplace_vendor_sub_orders",   // ← NEW: which table to query
  measures: [
    { name: "subtotal", sql: "subtotal", type: "sum" },
    { name: "commissionAmount", sql: "commission_amount", type: "sum" },
    { name: "count", type: "count" },
  ],
  dimensions: [
    { name: "vendorId", sql: "vendor_id", type: "string" },
    { name: "status", sql: "status", type: "string" },
  ],
}
```

The `DrizzleAnalyticsAdapter` reads this definition and generates SQL:

```sql
SELECT vendor_id AS "MarketplaceSubOrders.vendorId",
       SUM(subtotal) AS "MarketplaceSubOrders.subtotal"
FROM marketplace_vendor_sub_orders
GROUP BY vendor_id;
```

### With CubeJsAnalyticsAdapter

Plugin model definitions are written to temporary `.js` files that Cube.js discovers. The adapter generates Cube.js model files from the plugin definitions at boot time.

---

## 7. MCP Tool Compatibility

The `analytics_query` and `analytics_meta` MCP tools currently call `AnalyticsService.query()` and `AnalyticsService.getMeta()`. These methods delegate to the adapter. **No MCP tool changes needed** — the adapter abstraction means the tools work identically regardless of which backend is used.

---

## 8. Implementation Plan

### Phase 1: DrizzleAnalyticsAdapter (Days 1–3)

1. Define `AnalyticsAdapter` interface
2. Implement `DrizzleAnalyticsAdapter`:
   - Query-to-SQL compiler for measures (count, sum, avg, count_distinct)
   - Dimension mapping (column → alias)
   - Filter translation (equals, gt, lt, in, dateRange → WHERE clauses)
   - TimeDimension support (DATE_TRUNC for granularity)
   - GROUP BY, ORDER BY, LIMIT
3. Plugin model support: read `table` + `measures` + `dimensions` from model definitions, generate SQL
4. Remove in-memory `analyticsEvents[]` array and `recordEvent()` method
5. Wire adapter into `AnalyticsService` via config
6. Update tests to use the new adapter

### Phase 2: CubeJsAnalyticsAdapter (Days 4–7)

7. Create `packages/adapters/adapter-cubejs/`
8. Implement embedded Cube.js setup with `@cubejs-backend/server-core`
9. Generate Cube.js model files from:
   - Built-in models (Orders, OrderLineItems, Inventory, Customers)
   - Plugin-registered models (MarketplaceSubOrders, POSSessions, etc.)
   - Custom schema models from `config.analytics.customSchemaPath`
10. Configure pre-aggregations (daily revenue, monthly summaries)
11. Implement `CubeJsAnalyticsAdapter` that delegates to the Cube.js API
12. Test with Runvae marketplace data

---

## 9. Scale Analysis

| Metric | DrizzleAdapter | CubeJsAdapter |
|--------|---------------|---------------|
| 1K orders | 5ms query | 2ms (pre-agg) |
| 10K orders | 20ms query | 2ms (pre-agg) |
| 100K orders | 200ms query | 3ms (pre-agg) |
| 1M orders | 2s+ query | 5ms (pre-agg) |
| Memory overhead | ~0 (SQL only) | ~150MB (Cube.js runtime) |
| Disk overhead | ~0 | Pre-agg tables (~10-50MB) |

For Runvae's current scale (6,000 orders/month target), the DrizzleAdapter is sufficient. The CubeJsAdapter becomes valuable above ~50K orders/month where pre-aggregation caching pays off.

---

## 10. Key Files

| File | Change Type |
|------|-------------|
| `packages/core/src/modules/analytics/adapter.ts` | NEW — AnalyticsAdapter interface |
| `packages/core/src/modules/analytics/drizzle-adapter.ts` | NEW — SQL-based implementation |
| `packages/core/src/modules/analytics/service.ts` | REWRITE — delegate to adapter |
| `packages/core/src/modules/analytics/hooks.ts` | MODIFY — remove recordEvent |
| `packages/core/src/config/types.ts` | MODIFY — add analytics.adapter option |
| `packages/adapters/adapter-cubejs/` | NEW package (Phase 2) |

---

## 11. What This Does NOT Do

- **No event sourcing.** Analytics reads from the existing orders/inventory/customers tables. There is no separate event stream.
- **No real-time streaming.** Both adapters run queries against PostgreSQL tables. Real-time dashboards need to poll (or use Cube.js's WebSocket subscriptions in Phase 2).
- **No breaking API changes.** The `analytics.query()` params and response format stay identical. Only the backend changes.
- **No removal of MCP tools.** The `analytics_query` and `analytics_meta` tools work unchanged via the adapter abstraction.
