# @porulle/plugin-marketplace

A production-grade, headless multi-vendor marketplace plugin for [Porulle](../../../README.md). This plugin transforms a single-tenant storefront into a fully operational marketplace where multiple vendors sell through a unified platform — handling everything from vendor onboarding and commission calculations through to dispute resolution and vendor payouts.

It is designed for both **B2C marketplaces** (think Amazon, Etsy, Zalando) and **B2B marketplaces** (think Alibaba, Faire, ThomasNet) — the B2B capabilities (RFQ, contract pricing) are opt-in and activate only when you need them.

## Philosophy

This plugin was built around five principles that informed every design decision:

### 1. Headless-first

Every single capability is a REST endpoint. There are no server-rendered views, no admin panels baked in, no assumptions about your frontend stack. Whether you're building with Next.js, Nuxt, Flutter, or a custom React Native app, the marketplace is just an API. Your frontend calls endpoints, receives JSON, and renders however you see fit.

This means you can build a vendor dashboard in React, a customer-facing marketplace in Svelte, and an admin panel in Vue — all consuming the same API surface. The plugin doesn't care.

### 2. Progressive complexity

A simple B2C marketplace should be simple to set up. You shouldn't have to understand RFQ workflows or contract pricing tiers just to let vendors list products and take orders.

```typescript
// This is a complete, working marketplace:
import { marketplacePlugin } from "@porulle/plugin-marketplace";

export default defineConfig({
  plugins: [marketplacePlugin()],
  // ... rest of your config
});
```

That's it. You get vendor registration, approval, product listing, order splitting, commission calculation, and payouts — all with sensible defaults (10% commission, weekly payouts, 7-day holdback, manual approval).

When you need more, you layer it on:

```typescript
marketplacePlugin({
  defaultCommissionRateBps: 1500, // 15%
  defaultPayoutSchedule: "biweekly",
  defaultHoldbackDays: 14,
  vendorApprovalMode: "auto",
  requireVerifiedPurchase: true,
  reviewModerationEnabled: true,

  // B2B features — only activate when you need them
  b2b: {
    rfq: true,
    contractPricing: true,
  },

  performanceThresholds: {
    minRating: 3.5,
    maxDefectRatePercent: 3,
    maxLateShipmentRatePercent: 8,
  },
});
```

### 3. Convention over configuration

Every option has a default that makes sense for most marketplaces:

| Setting | Default | Why |
|---------|---------|-----|
| Commission rate | 10% (1000 bps) | Industry standard for general merchandise |
| Payout schedule | Weekly | Balances vendor cash flow with platform risk |
| Holdback period | 7 days | Covers most return windows |
| Payout minimum | $50 (5000 cents) | Avoids micro-transfers and processing fees |
| Vendor approval | Manual | Platform quality control from day one |
| Dispute deadline | 3 days | Vendors must respond within 72 hours |
| Return window | 30 days | Consumer protection standard |

You only override what you need. If a default works for you, you never have to think about it.

### 4. Event-driven

Every state transition in the system — vendor approved, sub-order shipped, payout completed, dispute escalated — can trigger external reactions. The plugin integrates with the core webhook system so external services can listen for events like `vendor.approved`, `suborder.shipped`, `payout.completed`, and `dispute.resolved`.

This is how you wire up email notifications, Slack alerts, ERP syncs, or any custom integration without touching plugin code.

### 5. Vendor-scoped by default

The vendor portal routes (`/api/marketplace/vendor/me/*`) automatically scope every query to the authenticated vendor's ID. A vendor calling `GET /api/marketplace/vendor/me/orders` will only ever see their own sub-orders. They cannot see another vendor's products, revenue, balance, or customer data. This isn't a feature you enable — it's how the system works.

The scoping is enforced at the route level by reading `actor.vendorId` from the authentication context. If a request hits a vendor portal endpoint without a `vendorId` on the actor, it gets a 403 — no data leaks, no configuration required.

---

## How It Works

### The Order Lifecycle

When a customer places an order containing items from multiple vendors, the marketplace plugin intercepts the `orders.afterCreate` hook and does the following:

1. **Groups line items by vendor** — Each item is traced back to its vendor through the `vendor_entities` linking table.

2. **Calculates commission per vendor** — The commission rules engine evaluates rules in priority order: vendor+category specific rules first, then category rules, vendor tier rules, volume tier rules, promotional rules, the vendor's flat rate, and finally the plugin default.

3. **Creates sub-orders** — Each vendor gets a separate sub-order with their line items, subtotal, commission amount, and payout amount.

4. **Credits the vendor balance** — Two ledger entries are created: a sale credit (the payout amount) and a commission debit. The vendor's running balance updates immediately.

From there, each vendor manages their own sub-order through the fulfillment lifecycle:

```
pending → confirmed → processing → shipped → delivered
```

The parent order can only transition to "fulfilled" when **all** vendor sub-orders are delivered. This is enforced by the `orders.beforeStatusChange` hook — the platform cannot prematurely mark an order complete.

### The Commission Rules Engine

The flat "X% on everything" model works for simple marketplaces, but real platforms need differentiated rates. The commission engine supports five rule types, evaluated in priority order:

```
1. Vendor + category specific  (highest priority)
2. Category-wide
3. Vendor performance tier
4. Sales volume tier
5. Promotional (time-limited)
6. Vendor flat rate            (fallback)
7. Plugin default              (last resort)
```

This means you can express policies like:
- "Electronics are 8% commission, fashion is 20%"
- "Gold-tier vendors get a 2% discount on any rate"
- "New vendors pay only 5% for their first 90 days"
- "Vendor X has a negotiated 12% rate on electronics specifically"

Rules are managed through the admin API:

```bash
# Create a category-based commission rule
curl -X POST /api/marketplace/commission-rules \
  -d '{"name": "Fashion 20%", "type": "category", "categorySlug": "fashion", "rateBps": 2000}'

# Preview what rate a vendor would pay
curl -X POST /api/marketplace/commission-rules/preview \
  -d '{"vendorId": "...", "categorySlug": "electronics"}'
# → {"rateBps": 800, "ratePercent": 8}
```

### The Financial Ledger

Every financial event — sale, commission deduction, refund, payout — creates an entry in the vendor balance ledger (`marketplace_vendor_balances`). Each entry records the amount, running balance, and a reference to the entity that triggered it (sub-order, payout, refund).

This gives you a complete, auditable financial history per vendor:

```
+$85.00  sale         sub_order/abc-123   "Sale from order 7f3a..."
-$15.00  commission   sub_order/abc-123   "Commission (1500bps) on order 7f3a..."
-$70.00  payout       payout/def-456      "Payout #def45678"
```

When you run a payout cycle (`POST /api/marketplace/payouts/run`), the system:
1. Finds vendors whose balance exceeds their minimum payout threshold
2. Checks that eligible sales are past the holdback period
3. Calculates deductions (refunds, adjustments)
4. Creates a payout record with gross/deductions/net breakdown
5. Debits the vendor balance via a ledger entry
6. Returns the payout details for your payment provider integration

### Dispute Resolution

Disputes follow a three-stage process:

**Stage 1: Vendor Response** — Customer opens a dispute. The vendor gets a deadline (default: 3 days) to respond with evidence. If they miss the deadline, the dispute auto-escalates.

**Stage 2: Platform Review** — Both parties have submitted their evidence. The platform admin reviews and makes a binding decision: full refund, partial refund, replacement, or rejection.

**Stage 3: Escalation** — For complex cases, disputes can be manually escalated for specialized review. All actions, messages, and evidence are logged in the `evidence` JSONB array for a complete audit trail.

```bash
# Customer opens a dispute
curl -X POST /api/marketplace/disputes \
  -d '{"subOrderId": "...", "openedBy": "customer", "reason": "item_not_as_described", "description": "..."}'

# Vendor responds with evidence
curl -X POST /api/marketplace/disputes/:id/respond \
  -d '{"party": "vendor", "note": "Item matches listing photos", "url": "https://..."}'

# Platform resolves
curl -X POST /api/marketplace/disputes/:id/resolve \
  -d '{"resolution": "refund_partial", "refundAmountCents": 2500, "resolvedBy": "platform", "notes": "..."}'
```

---

## Quick Start

### 1. Install

```bash
bun add @porulle/plugin-marketplace
```

### 2. Add to your config

```typescript
import { defineConfig } from "@porulle/core";
import { marketplacePlugin } from "@porulle/plugin-marketplace";

export default defineConfig({
  database: { provider: "postgresql" },
  plugins: [
    marketplacePlugin({
      defaultCommissionRateBps: 1200, // 12%
    }),
  ],
  // ...
});
```

### 3. Push the schema

```bash
bunx drizzle-kit push
```

### 4. Register a vendor

```bash
curl -X POST http://localhost:3000/api/marketplace/vendors \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme Electronics", "email": "vendor@acme.com"}'
```

### 5. Approve the vendor

```bash
curl -X POST http://localhost:3000/api/marketplace/vendors/:vendorId/approve
```

### 6. Create a product with vendor metadata

```bash
curl -X POST http://localhost:3000/api/catalog/product \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "wireless-headphones",
    "attributes": {"title": "Wireless Headphones"},
    "metadata": {"vendorId": "<vendorId>", "basePrice": 4999}
  }'
```

The `catalog.afterCreate` hook automatically links the product to the vendor.

### 7. Place an order

When a customer checks out, the `orders.afterCreate` hook:
- Creates vendor sub-orders
- Calculates commission via the rules engine
- Credits the vendor balance ledger

### 8. Vendor fulfills their sub-order

```bash
# Vendor confirms
curl -X POST /api/marketplace/vendor/me/orders/:subOrderId/confirm

# Vendor ships with tracking
curl -X POST /api/marketplace/vendor/me/orders/:subOrderId/ship \
  -d '{"trackingNumber": "1Z999AA10123456784", "carrier": "UPS"}'

# Vendor marks delivered
curl -X POST /api/marketplace/vendor/me/orders/:subOrderId/deliver
```

### 9. Run payouts

```bash
curl -X POST /api/marketplace/payouts/run
```

---

## API Reference

### Vendor Management (Platform Admin)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/marketplace/vendors` | List vendors (filters: `?status`, `?tier`, `?search`) |
| POST | `/api/marketplace/vendors` | Register vendor |
| GET | `/api/marketplace/vendors/:id` | Get vendor detail |
| PATCH | `/api/marketplace/vendors/:id` | Update vendor |
| POST | `/api/marketplace/vendors/:id/approve` | Approve vendor |
| POST | `/api/marketplace/vendors/:id/reject` | Reject (body: `{reason}`) |
| POST | `/api/marketplace/vendors/:id/suspend` | Suspend (body: `{reason}`) |
| POST | `/api/marketplace/vendors/:id/reinstate` | Reinstate suspended vendor |
| GET | `/api/marketplace/vendors/:id/documents` | List verification documents |
| POST | `/api/marketplace/vendors/:id/documents/:docId/approve` | Approve document |
| POST | `/api/marketplace/vendors/:id/documents/:docId/reject` | Reject document |
| GET | `/api/marketplace/vendors/:id/balance` | Vendor balance ledger |
| GET | `/api/marketplace/vendors/:id/performance` | Performance metrics + rating |

### Vendor Portal (Self-Service)

All endpoints are scoped to the authenticated vendor via `actor.vendorId`. Returns 403 if the actor has no vendor association.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/marketplace/vendor/me` | Current vendor profile |
| PATCH | `/api/marketplace/vendor/me` | Update own profile |
| POST | `/api/marketplace/vendor/me/documents` | Upload verification document |
| GET | `/api/marketplace/vendor/me/documents` | List own documents |
| GET | `/api/marketplace/vendor/me/products` | List own products |
| GET | `/api/marketplace/vendor/me/orders` | List own sub-orders |
| GET | `/api/marketplace/vendor/me/orders/:id` | Sub-order detail |
| POST | `/api/marketplace/vendor/me/orders/:id/confirm` | Confirm sub-order |
| POST | `/api/marketplace/vendor/me/orders/:id/ship` | Ship (body: `{trackingNumber, carrier}`) |
| POST | `/api/marketplace/vendor/me/orders/:id/deliver` | Mark delivered |
| POST | `/api/marketplace/vendor/me/orders/:id/cancel` | Cancel (body: `{reason}`) |
| GET | `/api/marketplace/vendor/me/payouts` | Payout history |
| GET | `/api/marketplace/vendor/me/balance` | Balance ledger |
| GET | `/api/marketplace/vendor/me/analytics` | Sales summary + ratings |
| GET | `/api/marketplace/vendor/me/reviews` | Reviews received |
| POST | `/api/marketplace/vendor/me/reviews/:id/respond` | Respond to a review |
| GET | `/api/marketplace/vendor/me/returns` | Return requests |
| POST | `/api/marketplace/vendor/me/returns/:id/approve` | Approve return |
| POST | `/api/marketplace/vendor/me/returns/:id/reject` | Reject return |

### Sub-Orders, Commissions, Payouts, Disputes, Returns, Reviews

| Group | Endpoints | Count |
|-------|-----------|-------|
| Sub-Orders (admin) | List, detail, force status | 3 |
| Commission Rules | CRUD + preview | 5 |
| Payouts | List, run cycle, retry, detail | 4 |
| Disputes | Open, list, detail, respond, escalate, resolve | 6 |
| Returns | Request, list, detail, ship-back, receive | 5 |
| Reviews | Submit, list, moderate | 3 |

### B2B (opt-in)

| Group | Endpoints | Enabled by |
|-------|-----------|------------|
| RFQ | Create, list, detail, respond, award, close | `b2b.rfq: true` |
| Contract Pricing | CRUD | `b2b.contractPricing: true` |

---

## Plugin Options

```typescript
interface MarketplacePluginOptions {
  // ── Commission ──────────────────────────────────────────────
  defaultCommissionRateBps?: number;         // Default: 1000 (10%)

  // ── Vendor Onboarding ───────────────────────────────────────
  vendorApprovalMode?: "manual" | "auto" | "invitation";
  requiredDocuments?: Array<"business_license" | "tax_form" | "bank_proof" | "identity">;

  // ── Payouts ─────────────────────────────────────────────────
  defaultPayoutSchedule?: "daily" | "weekly" | "biweekly" | "monthly" | "manual";
  defaultPayoutMinimumCents?: number;        // Default: 5000 ($50)
  defaultHoldbackDays?: number;              // Default: 7

  // ── Disputes ────────────────────────────────────────────────
  vendorResponseDeadlineDays?: number;       // Default: 3
  autoEscalateOnMissedDeadline?: boolean;    // Default: true

  // ── Returns ─────────────────────────────────────────────────
  returnWindowDays?: number;                 // Default: 30
  autoApproveReturnsOnVendorTimeout?: boolean;
  vendorReturnResponseDays?: number;         // Default: 5

  // ── Reviews ─────────────────────────────────────────────────
  requireVerifiedPurchase?: boolean;         // Default: true
  reviewModerationEnabled?: boolean;         // Default: false

  // ── B2B (opt-in) ───────────────────────────────────────────
  b2b?: {
    rfq?: boolean;                           // Default: false
    contractPricing?: boolean;               // Default: false
  };

  // ── Performance Enforcement ─────────────────────────────────
  performanceThresholds?: {
    minRating?: number;                      // Default: 3.0
    maxDefectRatePercent?: number;            // Default: 5
    maxLateShipmentRatePercent?: number;      // Default: 10
    maxCancellationRatePercent?: number;      // Default: 5
  };
}
```

---

## Schema

The plugin manages 13 PostgreSQL tables:

| Table | Purpose |
|-------|---------|
| `marketplace_vendors` | Vendor profiles, status, tier, financial settings |
| `marketplace_vendor_entities` | Links vendors to catalog entities (products) |
| `marketplace_vendor_documents` | KYC/verification document uploads |
| `marketplace_commission_rules` | Category, tier, volume, and promotional commission rules |
| `marketplace_vendor_sub_orders` | Per-vendor order segments with fulfillment tracking |
| `marketplace_vendor_payouts` | Payout records with gross/deductions/net breakdown |
| `marketplace_vendor_balances` | Append-only financial ledger per vendor |
| `marketplace_disputes` | Dispute lifecycle with evidence trail |
| `marketplace_vendor_reviews` | Vendor ratings and reviews |
| `marketplace_return_requests` | Per-sub-order return/RMA requests |
| `marketplace_rfq` | Request for Quote (B2B) |
| `marketplace_rfq_responses` | Vendor bids on RFQs (B2B) |
| `marketplace_contract_prices` | Negotiated pricing per buyer/vendor/product (B2B) |

---

## Architecture

```
plugin-marketplace/
  src/
    index.ts                    ← Plugin entrypoint, wires services/routes/hooks
    types.ts                    ← TypeScript types, state machines, options interface
    schema.ts                   ← All 13 Drizzle pgTable definitions
    hooks.ts                    ← Catalog + order lifecycle hooks
    mcp-tools.ts                ← 8 AI agent tools
    services/
      vendor.ts                 ← Vendor CRUD, onboarding, documents
      sub-order.ts              ← Sub-order state machine
      commission.ts             ← Priority-based commission rules engine
      payout.ts                 ← Balance ledger + payout scheduling
      dispute.ts                ← Dispute lifecycle
      return.ts                 ← Return request lifecycle
      review.ts                 ← Vendor reviews + aggregate ratings
      rfq.ts                    ← RFQ lifecycle (B2B)
      contract-price.ts         ← Negotiated pricing (B2B)
    routes/
      vendors.ts                ← Platform admin vendor management
      vendor-portal.ts          ← Vendor self-service (scoped by actor.vendorId)
      sub-orders.ts             ← Sub-order admin
      commission.ts             ← Commission rules CRUD
      payouts.ts                ← Payout management
      disputes-returns-reviews.ts ← Trust & safety
      b2b.ts                    ← RFQ + contract pricing (conditional)
```

### Type Safety

The plugin uses `PgDatabase<PgQueryResultHKT>` from `drizzle-orm/pg-core` — the driver-agnostic base type that both `PostgresJsDatabase` (production) and `PgliteDatabase` (tests) extend. This means:

- Row types are fully inferred from `pgTable` schema definitions
- No coupling to any specific PostgreSQL driver
- Zero `as any` casts in the entire codebase
- All catch blocks use `err: unknown` with proper type narrowing

---

## MCP Tools

The plugin exposes 8 tools for AI agent integration:

| Tool | Description |
|------|-------------|
| `marketplace_vendor_list` | List vendors with filters |
| `marketplace_vendor_performance` | Get vendor metrics, tier, and rating |
| `marketplace_vendor_balance` | Get balance and recent ledger entries |
| `marketplace_suborder_update` | Transition sub-order status |
| `marketplace_dispute_summary` | List open disputes with deadlines |
| `marketplace_payout_run` | Trigger payout cycle |
| `marketplace_commission_preview` | Preview effective rate for vendor+category |
| `marketplace_rfq_list` | List open RFQs (B2B) |

---

## What's Not Included (and Why)

These capabilities are intentionally outside the plugin's scope:

- **Split payment integration** (Stripe Connect, PayPal Marketplace) — Requires payment adapter extensions specific to your payment provider. The plugin calculates amounts; your adapter moves money.
- **Buy Box algorithm** — Requires a product-level multi-vendor offers table and ranking logic that varies wildly by marketplace type.
- **Fulfillment-by-platform** — Requires warehouse management beyond marketplace scope.
- **Vendor storefront theming** — Frontend concern. The plugin is headless.
- **Real-time inventory sync** — WebSocket infrastructure, separate concern.
- **ML recommendations** — External service integration.
