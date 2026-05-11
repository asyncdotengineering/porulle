# RFC-007: Scoped Analytics — Role-Based Query Filtering

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-15
- **Scope:** `packages/core/src/modules/analytics/`, `packages/plugins/plugin-marketplace/`
- **Depends on:** RFC-006 (implemented — DrizzleAnalyticsAdapter + CubeJsAdapter)
- **Estimated effort:** 2–3 days

---

## 1. Summary

The analytics system currently returns all data regardless of who's asking. A vendor querying "Orders.revenue" sees the entire platform's revenue, not just their own. A customer querying order analytics sees every customer's orders.

This RFC adds **query scoping** — the adapter automatically injects WHERE filters based on the actor's role and identity. The API stays identical; the scoping is invisible to the caller. This follows the same pattern as Cube.js's `queryRewrite` with `securityContext`.

---

## 2. Problem

### Current behavior

```
Vendor A calls: analytics_query({ measures: ["Orders.revenue"] })
→ Returns: $2,426,266.02 (ALL orders across ALL vendors)
→ Expected: $748,000 (only Vendor A's sub-orders)

Customer calls: analytics_query({ measures: ["Orders.count"] })
→ Returns: 19,449 (ALL orders)
→ Expected: 7 (only this customer's orders)

Admin calls: analytics_query({ measures: ["Orders.revenue"] })
→ Returns: $2,426,266.02 (ALL orders)
→ This is correct — admins see everything
```

### Why this matters

1. **Data leakage** — vendors see competitor revenue, customer counts, product sales
2. **Misleading metrics** — a vendor sees platform-wide revenue and thinks it's theirs
3. **Compliance risk** — GDPR/privacy regulations require data isolation per tenant
4. **Marketplace trust** — vendors won't trust a platform that shows them other vendors' data

---

## 3. Design

### Query Scoping via Actor Context

The `AnalyticsAdapter.query()` method receives an optional `AnalyticsScope` that describes who's asking:

```typescript
interface AnalyticsScope {
  role: "admin" | "vendor" | "customer" | "public";
  vendorId?: string;   // set when role = "vendor"
  customerId?: string; // set when role = "customer"
}
```

The adapter applies scope-based filters before executing the query:

| Role | Cube | Auto-injected filter |
|------|------|---------------------|
| **admin** | Any | None — sees all data |
| **vendor** | Orders | JOIN marketplace_vendor_sub_orders WHERE vendor_id = :vendorId |
| **vendor** | OrderLineItems | JOIN through sub-orders to filter by vendor |
| **vendor** | Inventory | WHERE entity_id IN (vendor's products) |
| **customer** | Orders | WHERE customer_id = :customerId |
| **customer** | OrderLineItems | WHERE order_id IN (customer's orders) |
| **public** | Any | Only aggregated data, no dimensions that expose individual records |

### How it flows

```
MCP tool: analytics_query(params)
  → REST route extracts actor from auth context
  → Builds AnalyticsScope from actor (vendorId, customerId, role)
  → Calls: adapter.query(params, { scope })
  → DrizzleAdapter injects WHERE clauses based on scope
  → Returns filtered results
```

### Marketplace-specific cubes

The marketplace plugin should register its own scoped cubes:

```typescript
// Vendor-scoped cubes — registered by marketplace plugin
{
  name: "VendorOrders",
  table: "marketplace_vendor_sub_orders",
  measures: {
    count: { type: "count" },
    revenue: { sql: "subtotal", type: "sum" },
    commissionPaid: { sql: "commission_amount", type: "sum" },
    netPayout: { sql: "payout_amount", type: "sum" },
  },
  dimensions: {
    status: { sql: "status", type: "string" },
    createdAt: { sql: "created_at", type: "time" },
  },
}

{
  name: "VendorBalance",
  table: "marketplace_vendor_balances",
  measures: {
    totalCredits: { sql: "CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END", type: "sum" },
    totalDebits: { sql: "CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END", type: "sum" },
    currentBalance: { sql: "amount_cents", type: "sum" },
  },
  dimensions: {
    type: { sql: "type", type: "string" },
    createdAt: { sql: "created_at", type: "time" },
  },
}

{
  name: "VendorReviews",
  table: "marketplace_vendor_reviews",
  measures: {
    count: { type: "count" },
    averageRating: { sql: "rating", type: "avg" },
  },
  dimensions: {
    status: { sql: "status", type: "string" },
    createdAt: { sql: "created_at", type: "time" },
  },
}
```

These cubes are automatically scoped by `vendor_id` when a vendor queries them.

### Runvae-specific analytics

With scoped analytics, Runvae can offer:

**Vendor dashboard:**
- My revenue this month (VendorOrders.revenue, time dimension)
- My order count by status (VendorOrders.count, status dimension)
- My commission paid (VendorOrders.commissionPaid)
- My payout history (VendorBalance by type)
- My average review rating (VendorReviews.averageRating)
- My top-selling products (via OrderLineItems scoped to vendor's entities)

**Admin dashboard:**
- Platform GMV (Orders.revenue)
- Total commission earned (MarketplaceSubOrders.commissionAmount)
- Vendor performance comparison
- Revenue by vendor (new dimension)
- Payout totals
- Dispute and return rates

**Customer portal:**
- My total spend (Orders.revenue scoped to customer)
- My order count
- My most purchased products

---

## 4. Implementation

### Phase 1: Add scope to adapter interface

```typescript
// Update AnalyticsAdapter interface
interface AnalyticsAdapter {
  query(params: AnalyticsQueryParams, scope?: AnalyticsScope): Promise<Result<AnalyticsQueryResult>>;
  getMeta(scope?: AnalyticsScope): Promise<Result<AnalyticsMeta>>;
  registerCube(cube: CubeDefinition): void;
}
```

### Phase 2: Implement scope filtering in DrizzleAdapter

The `executeQuery` method checks the scope and injects WHERE clauses:

```typescript
// In drizzle-adapter.ts
if (scope?.role === "vendor" && scope.vendorId) {
  if (cubeName === "VendorOrders" || cubeName === "MarketplaceSubOrders") {
    whereParts.push(sql`vendor_id = ${scope.vendorId}`);
  }
  if (cubeName === "Orders") {
    // Join through sub-orders to scope by vendor
    whereParts.push(sql`id IN (
      SELECT order_id FROM marketplace_vendor_sub_orders
      WHERE vendor_id = ${scope.vendorId}
    )`);
  }
}

if (scope?.role === "customer" && scope.customerId) {
  if (cubeName === "Orders") {
    whereParts.push(sql`customer_id = ${scope.customerId}`);
  }
}
```

### Phase 3: Wire scope from MCP tools and REST routes

```typescript
// In MCP analytics_query handler:
const actor = kernel.getMCPActor(); // or from auth context
const scope: AnalyticsScope = {
  role: actor.role === "admin" ? "admin"
      : actor.vendorId ? "vendor"
      : actor.userId ? "customer"
      : "public",
  vendorId: actor.vendorId ?? undefined,
  customerId: actor.userId ?? undefined,
};

const result = await kernel.services.analytics.query(params, scope);
```

### Phase 4: Register marketplace cubes

The marketplace plugin registers VendorOrders, VendorBalance, VendorReviews cubes with the analytics adapter at boot time via `analyticsModels()` with full SQL definitions.

### Phase 5: Cube.js queryRewrite

For the CubeJsAdapter, scope translates to `securityContext` which Cube.js uses in `queryRewrite`:

```javascript
// cube.js config
module.exports = {
  queryRewrite: (query, { securityContext }) => {
    if (securityContext.vendorId) {
      query.filters.push({
        member: "VendorOrders.vendorId",
        operator: "equals",
        values: [securityContext.vendorId],
      });
    }
    return query;
  },
};
```

---

## 5. Security Model

| Role | Can query | Auto-filtered by |
|------|-----------|-----------------|
| admin / owner | All cubes | Nothing — full access |
| staff | All cubes | Nothing — staff sees platform data |
| vendor | VendorOrders, VendorBalance, VendorReviews, Inventory (own products) | vendor_id |
| customer | Orders (own), OrderLineItems (own) | customer_id |
| public / anonymous | None | Blocked — analytics requires auth |
| ai_agent | All cubes (same as admin) | Nothing — agents serve admins |

### What vendors CANNOT see:
- Other vendors' revenue, order counts, or product sales
- Platform-wide totals (unless the cube explicitly provides anonymized aggregates)
- Individual customer data
- Commission rates of other vendors

### What customers CANNOT see:
- Other customers' orders
- Vendor financial data
- Platform-wide analytics

---

## 6. Key Files

| File | Change |
|------|--------|
| `packages/core/src/modules/analytics/types.ts` | Add AnalyticsScope interface |
| `packages/core/src/modules/analytics/drizzle-adapter.ts` | Inject scope filters in executeQuery |
| `packages/core/src/modules/analytics/service.ts` | Pass scope through to adapter |
| `packages/core/src/interfaces/mcp/server.ts` | Extract scope from actor in analytics tools |
| `packages/plugins/plugin-marketplace/src/index.ts` | Register VendorOrders/Balance/Reviews cubes |
| `packages/adapters/adapter-cubejs/src/index.ts` | Pass scope as securityContext to Cube.js |
