# RFC-003: Complete Headless Marketplace — Multi-Vendor Commerce for B2C and B2B

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-14
- **Scope:** `packages/plugins/plugin-marketplace/`
- **Depends on:** RFC-002 (implemented — PostgreSQL-first, plugin uses Drizzle)
- **Estimated effort:** 8–10 days

---

## 1. Summary

The marketplace plugin today supports basic vendor CRUD, flat commission math, auto-splitting orders into sub-orders, and batch payout status flips. It is roughly 15% of what a production marketplace needs. Vendors cannot manage their own orders. Sub-orders have no status transitions. Payouts have no scheduling, thresholds, or reconciliation. There is no vendor portal, no reviews, no dispute resolution, no returns routing, no commission tiers, and no B2B primitives (RFQ, contract pricing, approval chains).

This RFC defines the schema, routes, hooks, and service layer required to make `plugin-marketplace` a production-grade headless marketplace that covers 90%+ of what developers need out of the box for both B2C and B2B multi-vendor commerce.

---

## 2. Motivation

### 2.1 Competitive Gap

Every serious marketplace platform (Mirakl, Sharetribe, Vendure multi-vendor, Mercur/MedusaJS, Spree, CS-Cart Multi-Vendor) ships vendor onboarding workflows, sub-order fulfillment management, tiered commissions, split-payment orchestration, dispute resolution, and vendor analytics. Our plugin has none of these. A developer evaluating the engine for a marketplace use case would need to build all of this from scratch, defeating the purpose of a plugin.

### 2.2 Vendor Lifecycle Is Incomplete

Current flow: `POST /vendors` → status "pending" → `POST /vendors/:id/approve` → status "approved". No rejection with reason, no re-submission, no suspension, no probation, no performance tracking, no document verification. A real marketplace needs vendors to submit business documents, go through KYC, get conditionally approved for categories, and face automatic enforcement when metrics drop.

### 2.3 Sub-Orders Are Write-Only

Sub-orders are created on `orders.afterCreate` but there is no API to transition them through `confirmed → processing → shipped → delivered`. The `orders.beforeStatusChange` hook blocks parent fulfillment until all sub-orders are "delivered", but no endpoint exists to set that status. Vendors are locked out of their own order lifecycle.

### 2.4 Payouts Are Not Production-Ready

`POST /payouts/process` flips all pending payouts to "paid" in a single batch with no idempotency, no minimum threshold, no scheduling, no refund deductions, no failed-payout retry, and no audit trail. A real marketplace needs configurable payout cycles, holdback periods for return windows, and automatic deductions when orders are refunded.

### 2.5 No B2B Support

B2B marketplaces represent a $26T+ market (Statista 2025). They require RFQ workflows, purchase order lifecycle, approval hierarchies, contract/negotiated pricing, net payment terms, and buyer organization management. None of these exist.

---

## 3. Design Principles

1. **Headless-first.** Every capability is a REST endpoint. No server-rendered UI assumptions. Frontends consume JSON APIs.
2. **Progressive complexity.** A simple B2C marketplace works with just vendor CRUD + orders. B2B features (RFQ, contract pricing) are opt-in via plugin options.
3. **Convention over configuration.** Sensible defaults for commission (10%), payout cycle (weekly), holdback period (7 days), vendor approval (manual). All overridable.
4. **Event-driven.** Every state transition emits a webhook event. External systems can react to `vendor.approved`, `suborder.shipped`, `payout.completed`, `dispute.escalated`.
5. **Vendor-scoped by default.** Vendor portal routes use actor.vendorId for scoping. No vendor can see another vendor's data.

---

## 4. Schema Additions

### 4.1 Vendor Profile Extensions

Extend `marketplace_vendors` table:

| Column | Type | Purpose |
|--------|------|---------|
| `slug` | text UNIQUE | URL-friendly vendor identifier |
| `description` | text | Public vendor description |
| `logo_url` | text | Vendor logo |
| `banner_url` | text | Vendor storefront banner |
| `contact_phone` | text | Business phone |
| `business_address` | jsonb | `{ line1, line2, city, state, postalCode, country }` |
| `bank_account` | jsonb | `{ accountHolder, bankName, routingNumber, accountNumber, iban, swift }` (encrypted at rest) |
| `tax_id` | text | Business tax identifier (EIN, VAT, GST) |
| `verification_status` | text | `unverified`, `documents_submitted`, `verified`, `rejected` |
| `rejection_reason` | text | Why verification was rejected |
| `approved_categories` | jsonb | Array of category slugs vendor may list in (null = all) |
| `tier` | text | `standard`, `silver`, `gold`, `platinum` (performance tier) |
| `performance_score` | integer | 0–100 composite score |
| `suspension_reason` | text | Why vendor was suspended |
| `suspended_at` | timestamp | When suspension began |
| `payout_schedule` | text | `daily`, `weekly`, `biweekly`, `monthly`, `manual` |
| `payout_minimum_cents` | integer | Minimum balance before payout triggers |
| `holdback_days` | integer | Days to hold payout after delivery (return window) |

### 4.2 New Tables

#### `marketplace_vendor_documents`

Stores KYC/verification documents uploaded by vendors.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `vendor_id` | uuid FK → vendors | |
| `type` | text NOT NULL | `business_license`, `tax_form`, `bank_proof`, `identity`, `other` |
| `file_url` | text NOT NULL | Storage URL (via core storage adapter) |
| `status` | text NOT NULL DEFAULT 'pending' | `pending`, `approved`, `rejected` |
| `reviewer_notes` | text | Admin notes on document |
| `uploaded_at` | timestamp | |
| `reviewed_at` | timestamp | |

#### `marketplace_commission_rules`

Enables category-based and tiered commission overrides beyond the flat vendor rate.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `name` | text NOT NULL | Rule display name |
| `type` | text NOT NULL | `category`, `volume_tier`, `vendor_tier`, `promotional` |
| `category_slug` | text | Applies to this category (null = all) |
| `vendor_id` | uuid | Applies to this vendor (null = all) |
| `vendor_tier` | text | Applies to vendors in this tier (null = all) |
| `min_volume_cents` | integer | Volume tier lower bound |
| `max_volume_cents` | integer | Volume tier upper bound |
| `rate_bps` | integer NOT NULL | Commission rate in basis points |
| `valid_from` | timestamp | |
| `valid_until` | timestamp | |
| `priority` | integer DEFAULT 0 | Higher priority wins conflicts |
| `is_active` | boolean DEFAULT true | |

#### `marketplace_vendor_balances`

Running ledger per vendor. Every financial event (sale, commission, refund, payout) creates a ledger entry.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `vendor_id` | uuid FK → vendors | |
| `type` | text NOT NULL | `sale`, `commission`, `refund_deduction`, `adjustment`, `payout` |
| `amount_cents` | integer NOT NULL | Positive = credit to vendor, negative = debit |
| `running_balance_cents` | integer NOT NULL | Vendor balance after this entry |
| `reference_type` | text | `sub_order`, `payout`, `refund`, `adjustment` |
| `reference_id` | uuid | ID of the referenced entity |
| `description` | text | Human-readable description |
| `created_at` | timestamp | |

#### `marketplace_disputes`

Dispute resolution workflow between buyers, vendors, and platform.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `sub_order_id` | uuid FK → sub_orders | |
| `opened_by` | text NOT NULL | `customer`, `vendor`, `platform` |
| `reason` | text NOT NULL | `item_not_received`, `item_not_as_described`, `defective`, `wrong_item`, `other` |
| `description` | text | Detailed complaint |
| `status` | text NOT NULL DEFAULT 'open' | `open`, `vendor_response_pending`, `platform_review`, `resolved`, `escalated`, `closed` |
| `resolution` | text | `refund_full`, `refund_partial`, `replacement`, `rejected`, `vendor_favor`, `buyer_favor` |
| `resolution_notes` | text | |
| `refund_amount_cents` | integer | If partial/full refund |
| `evidence` | jsonb | `[{ party, type, url, note, at }]` |
| `resolved_by` | text | `auto`, `vendor`, `platform` |
| `deadline_at` | timestamp | Vendor must respond by this time |
| `opened_at` | timestamp | |
| `resolved_at` | timestamp | |

#### `marketplace_vendor_reviews`

Vendor-level reviews (separate from product reviews).

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `vendor_id` | uuid FK → vendors | |
| `customer_id` | uuid | Reviewer |
| `order_id` | uuid | Order this review relates to |
| `rating` | integer NOT NULL | 1–5 |
| `title` | text | |
| `body` | text | |
| `status` | text DEFAULT 'published' | `pending`, `published`, `hidden`, `flagged` |
| `vendor_response` | text | Vendor's public reply |
| `vendor_responded_at` | timestamp | |
| `created_at` | timestamp | |

#### `marketplace_return_requests`

Per-sub-order return/RMA handling.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `sub_order_id` | uuid FK → sub_orders | |
| `customer_id` | uuid | |
| `reason` | text NOT NULL | `defective`, `wrong_item`, `not_as_described`, `changed_mind`, `other` |
| `description` | text | |
| `status` | text DEFAULT 'requested' | `requested`, `vendor_approved`, `vendor_rejected`, `shipped_back`, `received`, `refunded`, `closed` |
| `line_items` | jsonb | `[{ entityId, quantity, reason }]` — which items and how many |
| `refund_amount_cents` | integer | |
| `vendor_notes` | text | |
| `tracking_number` | text | Return shipment tracking |
| `requested_at` | timestamp | |
| `resolved_at` | timestamp | |

#### `marketplace_rfq` (B2B opt-in)

Request for Quote — buyers post requirements, vendors respond with bids.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `buyer_id` | uuid | Customer/organization requesting quote |
| `title` | text NOT NULL | |
| `description` | text | Detailed requirements |
| `category_slug` | text | Target category |
| `quantity` | integer | Desired quantity |
| `budget_cents` | integer | Maximum budget |
| `currency` | text DEFAULT 'USD' | |
| `deadline_at` | timestamp | Submission deadline |
| `status` | text DEFAULT 'open' | `open`, `closed`, `awarded`, `cancelled` |
| `awarded_vendor_id` | uuid | Winning vendor |
| `metadata` | jsonb | Custom fields |
| `created_at` | timestamp | |

#### `marketplace_rfq_responses`

Vendor bids on RFQs.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `rfq_id` | uuid FK → rfq | |
| `vendor_id` | uuid FK → vendors | |
| `unit_price_cents` | integer NOT NULL | Proposed price per unit |
| `total_price_cents` | integer NOT NULL | |
| `lead_time_days` | integer | Estimated delivery |
| `notes` | text | |
| `status` | text DEFAULT 'submitted' | `submitted`, `shortlisted`, `accepted`, `rejected`, `withdrawn` |
| `created_at` | timestamp | |

#### `marketplace_contract_prices` (B2B opt-in)

Negotiated pricing between a vendor and a specific buyer/organization.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | uuid PK | |
| `vendor_id` | uuid FK → vendors | |
| `buyer_id` | uuid | Customer or organization ID |
| `entity_id` | uuid | Product |
| `variant_id` | uuid | Variant (null = base product) |
| `price_cents` | integer NOT NULL | Negotiated price |
| `min_quantity` | integer DEFAULT 1 | Minimum order quantity for this price |
| `currency` | text DEFAULT 'USD' | |
| `valid_from` | timestamp | |
| `valid_until` | timestamp | |
| `created_at` | timestamp | |

### 4.3 Sub-Order Extensions

Extend `marketplace_vendor_sub_orders`:

| Column | Type | Purpose |
|--------|------|---------|
| `tracking_number` | text | Carrier tracking number |
| `carrier` | text | Carrier name (UPS, FedEx, etc.) |
| `shipped_at` | timestamp | |
| `delivered_at` | timestamp | |
| `confirmed_at` | timestamp | Vendor confirmed the sub-order |
| `cancelled_at` | timestamp | |
| `cancellation_reason` | text | |
| `vendor_notes` | text | Internal notes from vendor |

### 4.4 Payout Extensions

Extend `marketplace_vendor_payouts`:

| Column | Type | Purpose |
|--------|------|---------|
| `payout_method` | text | `bank_transfer`, `paypal`, `stripe_connect`, `manual` |
| `external_reference` | text | Payment processor transfer ID |
| `period_start` | timestamp | Payout covers this period |
| `period_end` | timestamp | |
| `gross_amount` | integer | Before deductions |
| `deductions` | jsonb | `[{ type, amount, reference }]` — refunds, adjustments |
| `net_amount` | integer | After deductions (this is what vendor receives) |
| `failed_at` | timestamp | |
| `failure_reason` | text | |
| `retry_count` | integer DEFAULT 0 | |

---

## 5. Service Layer Architecture

The current plugin has all logic in route handlers and hooks with no abstraction. This RFC introduces a service layer within the plugin.

### 5.1 Services

| Service | Responsibility |
|---------|---------------|
| `VendorService` | Vendor CRUD, onboarding workflow, verification, suspension, performance scoring |
| `SubOrderService` | Sub-order state machine, fulfillment transitions, vendor notifications |
| `CommissionService` | Resolve effective commission rate from rules (category, tier, volume, promo) |
| `PayoutService` | Balance ledger, payout scheduling, threshold checks, deductions, batch processing |
| `DisputeService` | Dispute lifecycle, deadline enforcement, auto-escalation, resolution |
| `ReturnService` | Return request lifecycle, vendor approval, refund routing |
| `ReviewService` | Vendor review CRUD, moderation, response, aggregate rating |
| `RFQService` | (B2B) RFQ lifecycle, bid management, award |
| `ContractPriceService` | (B2B) Negotiated pricing CRUD, resolution during checkout |

### 5.2 Commission Resolution Algorithm

When calculating commission for a line item, the engine evaluates rules in priority order:

```
1. Vendor-specific + category-specific rule (highest priority)
2. Category-specific rule (any vendor)
3. Vendor tier rule (e.g., "gold" vendors get 8%)
4. Volume tier rule (based on vendor's trailing 30-day GMV)
5. Promotional rule (time-limited override)
6. Vendor-level flat rate (vendor.commissionRateBps)
7. Plugin default rate (options.defaultCommissionRateBps ?? 1000)
```

The first matching active rule wins. This enables scenarios like:
- Electronics category: 8% commission
- Fashion category: 20% commission
- Gold-tier vendors: 2% discount on any rate
- New vendor promo: 5% for first 90 days

### 5.3 Sub-Order State Machine

```
pending → confirmed → processing → shipped → delivered
                   ↘ cancelled
                                    ↘ returned (via return request)
```

| Transition | Triggered By | Side Effects |
|------------|-------------|--------------|
| pending → confirmed | Vendor confirms | Webhook `suborder.confirmed` |
| confirmed → processing | Vendor begins fulfillment | Webhook `suborder.processing` |
| processing → shipped | Vendor adds tracking | Webhook `suborder.shipped`, customer notification |
| shipped → delivered | Carrier confirmation or vendor marks | Webhook `suborder.delivered`, payout holdback timer starts |
| any → cancelled | Vendor or platform | Webhook `suborder.cancelled`, refund initiated, balance debit |
| delivered → returned | Return request approved | Handled by ReturnService |

### 5.4 Dispute Resolution Flow

```
open → vendor_response_pending → platform_review → resolved/closed
                                               ↘ escalated → resolved/closed
```

- Customer opens dispute → vendor has `deadline_at` (default 3 days) to respond
- If vendor doesn't respond → auto-escalate to platform review
- Platform admin reviews evidence from both parties → binding resolution
- Resolution triggers refund (full/partial) or rejection
- All actions logged in `evidence` jsonb array

### 5.5 Payout Scheduling

Runs as a scheduled job (cron or kernel job runner):

```
1. For each vendor with payout_schedule matching today:
2. Calculate available_balance = sum(balance_entries) where vendor_id = X
3. If available_balance < payout_minimum_cents → skip
4. Find all sale entries older than holdback_days and not yet paid out
5. Sum eligible entries, subtract pending refund deductions
6. Create payout record with gross/deductions/net breakdown
7. Create balance ledger entry (negative, type=payout)
8. Trigger external payment (Stripe Connect transfer, bank API, etc.)
9. Webhook: payout.completed or payout.failed
```

---

## 6. REST API Additions

### 6.1 Vendor Management (Platform Admin)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/marketplace/vendors` | List vendors with filters (status, tier, search) |
| `POST` | `/api/marketplace/vendors` | Register vendor |
| `GET` | `/api/marketplace/vendors/:id` | Vendor detail |
| `PATCH` | `/api/marketplace/vendors/:id` | Update vendor |
| `POST` | `/api/marketplace/vendors/:id/approve` | Approve vendor |
| `POST` | `/api/marketplace/vendors/:id/reject` | Reject with reason |
| `POST` | `/api/marketplace/vendors/:id/suspend` | Suspend vendor |
| `POST` | `/api/marketplace/vendors/:id/reinstate` | Reinstate suspended vendor |
| `GET` | `/api/marketplace/vendors/:id/documents` | List vendor documents |
| `POST` | `/api/marketplace/vendors/:id/documents/:docId/approve` | Approve document |
| `POST` | `/api/marketplace/vendors/:id/documents/:docId/reject` | Reject document |
| `GET` | `/api/marketplace/vendors/:id/balance` | Vendor balance ledger |
| `GET` | `/api/marketplace/vendors/:id/performance` | Performance metrics |

### 6.2 Vendor Portal (Vendor Self-Service)

All scoped to `actor.vendorId`. Returns 403 if actor has no vendorId.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/marketplace/vendor/me` | Current vendor profile + stats |
| `PATCH` | `/api/marketplace/vendor/me` | Update own profile (name, description, logo, bank) |
| `POST` | `/api/marketplace/vendor/me/documents` | Upload verification document |
| `GET` | `/api/marketplace/vendor/me/documents` | List own documents |
| `GET` | `/api/marketplace/vendor/me/products` | List own products |
| `GET` | `/api/marketplace/vendor/me/orders` | List own sub-orders |
| `GET` | `/api/marketplace/vendor/me/orders/:subOrderId` | Sub-order detail |
| `POST` | `/api/marketplace/vendor/me/orders/:subOrderId/confirm` | Confirm sub-order |
| `POST` | `/api/marketplace/vendor/me/orders/:subOrderId/ship` | Mark shipped + tracking |
| `POST` | `/api/marketplace/vendor/me/orders/:subOrderId/deliver` | Mark delivered |
| `POST` | `/api/marketplace/vendor/me/orders/:subOrderId/cancel` | Cancel sub-order |
| `GET` | `/api/marketplace/vendor/me/payouts` | Payout history |
| `GET` | `/api/marketplace/vendor/me/balance` | Balance ledger |
| `GET` | `/api/marketplace/vendor/me/analytics` | Sales, revenue, ratings summary |
| `GET` | `/api/marketplace/vendor/me/reviews` | Reviews received |
| `POST` | `/api/marketplace/vendor/me/reviews/:id/respond` | Respond to a review |
| `GET` | `/api/marketplace/vendor/me/returns` | Return requests for vendor |
| `POST` | `/api/marketplace/vendor/me/returns/:id/approve` | Approve return |
| `POST` | `/api/marketplace/vendor/me/returns/:id/reject` | Reject return with reason |

### 6.3 Sub-Orders (Platform Admin)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/marketplace/sub-orders` | List with filters (orderId, vendorId, status) |
| `GET` | `/api/marketplace/sub-orders/:id` | Detail |
| `PATCH` | `/api/marketplace/sub-orders/:id/status` | Force status transition (admin override) |

### 6.4 Commission Rules (Platform Admin)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/marketplace/commission-rules` | List rules |
| `POST` | `/api/marketplace/commission-rules` | Create rule |
| `PATCH` | `/api/marketplace/commission-rules/:id` | Update rule |
| `DELETE` | `/api/marketplace/commission-rules/:id` | Delete rule |
| `POST` | `/api/marketplace/commission-rules/preview` | Preview effective rate for vendor+category |

### 6.5 Payouts (Platform Admin)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/marketplace/payouts` | List payouts with filters |
| `POST` | `/api/marketplace/payouts/run` | Trigger payout cycle for eligible vendors |
| `POST` | `/api/marketplace/payouts/:id/retry` | Retry failed payout |
| `GET` | `/api/marketplace/payouts/:id` | Payout detail with line items |

### 6.6 Disputes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/marketplace/disputes` | Open dispute (customer) |
| `GET` | `/api/marketplace/disputes` | List disputes (admin) |
| `GET` | `/api/marketplace/disputes/:id` | Dispute detail + evidence |
| `POST` | `/api/marketplace/disputes/:id/respond` | Vendor/customer adds response + evidence |
| `POST` | `/api/marketplace/disputes/:id/escalate` | Escalate to platform |
| `POST` | `/api/marketplace/disputes/:id/resolve` | Platform resolves dispute |

### 6.7 Returns

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/marketplace/returns` | Customer requests return |
| `GET` | `/api/marketplace/returns` | List returns (admin) |
| `GET` | `/api/marketplace/returns/:id` | Return detail |
| `POST` | `/api/marketplace/returns/:id/ship-back` | Customer adds return tracking |
| `POST` | `/api/marketplace/returns/:id/receive` | Vendor confirms receipt |

### 6.8 Reviews

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/marketplace/vendors/:id/reviews` | Submit vendor review (customer, verified purchase) |
| `GET` | `/api/marketplace/vendors/:id/reviews` | Public reviews for vendor |
| `PATCH` | `/api/marketplace/reviews/:id` | Moderate review (admin) |

### 6.9 RFQ (B2B, opt-in via `options.b2b.rfq: true`)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/marketplace/rfq` | Create RFQ (buyer) |
| `GET` | `/api/marketplace/rfq` | List RFQs (vendors see open ones in their categories) |
| `GET` | `/api/marketplace/rfq/:id` | RFQ detail |
| `POST` | `/api/marketplace/rfq/:id/respond` | Submit bid (vendor) |
| `POST` | `/api/marketplace/rfq/:id/award` | Award to vendor (buyer) |
| `POST` | `/api/marketplace/rfq/:id/close` | Close RFQ |

### 6.10 Contract Pricing (B2B, opt-in via `options.b2b.contractPricing: true`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/marketplace/contract-prices` | List contracts |
| `POST` | `/api/marketplace/contract-prices` | Create contract price |
| `PATCH` | `/api/marketplace/contract-prices/:id` | Update |
| `DELETE` | `/api/marketplace/contract-prices/:id` | Remove |

---

## 7. Hooks

### 7.1 Existing Hooks (Enhanced)

| Hook | Enhancement |
|------|-------------|
| `catalog.beforeCreate` | Also validate vendor is not suspended, and entity category is in `approved_categories` |
| `orders.afterCreate` | Commission resolved via `CommissionService` (rules engine) instead of flat rate. Balance ledger entries created. |
| `orders.beforeStatusChange` | Also check: if order is being refunded, trigger balance deductions and payout adjustments |

### 7.2 New Hooks

| Hook | Trigger | Purpose |
|------|---------|---------|
| `marketplace.vendor.afterApprove` | Vendor approved | Send welcome email, webhook `vendor.approved` |
| `marketplace.vendor.afterReject` | Vendor rejected | Send rejection email with reason, webhook `vendor.rejected` |
| `marketplace.vendor.afterSuspend` | Vendor suspended | Hide products, pause sub-orders, hold payouts, webhook `vendor.suspended` |
| `marketplace.suborder.afterConfirm` | Sub-order confirmed | Webhook `suborder.confirmed` |
| `marketplace.suborder.afterShip` | Sub-order shipped | Customer notification, webhook `suborder.shipped` |
| `marketplace.suborder.afterDeliver` | Sub-order delivered | Start holdback timer, webhook `suborder.delivered` |
| `marketplace.suborder.afterCancel` | Sub-order cancelled | Refund to customer, debit vendor balance, webhook `suborder.cancelled` |
| `marketplace.payout.afterComplete` | Payout processed | Vendor notification, webhook `payout.completed` |
| `marketplace.payout.afterFail` | Payout failed | Vendor notification, webhook `payout.failed` |
| `marketplace.dispute.afterOpen` | Dispute opened | Vendor notification with deadline, webhook `dispute.opened` |
| `marketplace.dispute.afterResolve` | Dispute resolved | Both parties notified, refund triggered if applicable, webhook `dispute.resolved` |
| `marketplace.return.afterRequest` | Return requested | Vendor notification, webhook `return.requested` |
| `marketplace.return.afterRefund` | Return refunded | Balance deduction, webhook `return.refunded` |
| `checkout.beforeCreate` | Checkout initiated | Resolve contract prices for B2B buyers (override unit prices) |

---

## 8. Plugin Options

```typescript
interface MarketplacePluginOptions {
  // Commission
  defaultCommissionRateBps?: number;           // Default: 1000 (10%)

  // Vendor onboarding
  vendorApprovalMode?: "manual" | "auto" | "invitation";  // Default: "manual"
  requiredDocuments?: Array<"business_license" | "tax_form" | "bank_proof" | "identity">;

  // Payouts
  defaultPayoutSchedule?: "daily" | "weekly" | "biweekly" | "monthly" | "manual";  // Default: "weekly"
  defaultPayoutMinimumCents?: number;          // Default: 5000 ($50)
  defaultHoldbackDays?: number;                // Default: 7

  // Disputes
  vendorResponseDeadlineDays?: number;         // Default: 3
  autoEscalateOnMissedDeadline?: boolean;      // Default: true

  // Returns
  returnWindowDays?: number;                   // Default: 30
  autoApproveReturnsOnVendorTimeout?: boolean; // Default: true
  vendorReturnResponseDays?: number;           // Default: 5

  // Reviews
  requireVerifiedPurchase?: boolean;           // Default: true
  reviewModerationEnabled?: boolean;           // Default: false

  // B2B (opt-in)
  b2b?: {
    rfq?: boolean;                             // Default: false
    contractPricing?: boolean;                 // Default: false
  };

  // Performance
  performanceThresholds?: {
    minRating?: number;                        // Below this → probation. Default: 3.0
    maxDefectRatePercent?: number;              // Above this → suspension warning. Default: 5
    maxLateShipmentRatePercent?: number;        // Default: 10
    maxCancellationRatePercent?: number;        // Default: 5
  };
}
```

---

## 9. Webhook Events

All events are delivered via the core webhook system (`orders.afterCreate` pattern).

| Event | Payload |
|-------|---------|
| `vendor.registered` | `{ vendorId, name, email }` |
| `vendor.approved` | `{ vendorId, name, approvedCategories }` |
| `vendor.rejected` | `{ vendorId, reason }` |
| `vendor.suspended` | `{ vendorId, reason }` |
| `vendor.reinstated` | `{ vendorId }` |
| `suborder.created` | `{ subOrderId, orderId, vendorId, subtotal }` |
| `suborder.confirmed` | `{ subOrderId, vendorId }` |
| `suborder.shipped` | `{ subOrderId, vendorId, trackingNumber, carrier }` |
| `suborder.delivered` | `{ subOrderId, vendorId }` |
| `suborder.cancelled` | `{ subOrderId, vendorId, reason }` |
| `payout.completed` | `{ payoutId, vendorId, netAmount, method }` |
| `payout.failed` | `{ payoutId, vendorId, reason }` |
| `dispute.opened` | `{ disputeId, subOrderId, reason }` |
| `dispute.resolved` | `{ disputeId, resolution, refundAmount }` |
| `return.requested` | `{ returnId, subOrderId, reason }` |
| `return.refunded` | `{ returnId, refundAmount }` |
| `rfq.created` | `{ rfqId, title, categorySlug }` |
| `rfq.awarded` | `{ rfqId, vendorId }` |

---

## 10. MCP Tool Additions

| Tool | Description |
|------|-------------|
| `marketplace_vendor_performance` | Get vendor performance metrics and tier |
| `marketplace_vendor_balance` | Get vendor current balance and recent ledger |
| `marketplace_suborder_update` | Transition sub-order status (confirm, ship, deliver) |
| `marketplace_dispute_summary` | List open disputes with deadlines |
| `marketplace_payout_run` | Trigger payout cycle |
| `marketplace_commission_preview` | Preview commission for vendor+category+amount |
| `marketplace_rfq_list` | List open RFQs (B2B) |

---

## 11. Implementation Plan

### Phase 1: Foundation (Days 1–3)

1. **Schema expansion** — All new tables and column additions from §4
2. **Service layer scaffold** — `VendorService`, `SubOrderService`, `CommissionService`, `PayoutService` with repository access via `ctx.database.db`
3. **Sub-order state machine** — Implement transitions with validation
4. **Commission rules engine** — Priority-based rule resolution from §5.2
5. **Vendor portal routes** — `/vendor/me/*` endpoints from §6.2

### Phase 2: Financial (Days 4–5)

6. **Balance ledger** — Every sale/commission/refund/payout creates a ledger entry
7. **Payout scheduling** — Job-based payout runs with holdback, minimum, deductions
8. **Payout extensions** — gross/deductions/net breakdown, external reference tracking
9. **Refund routing** — When order refunded, debit vendor balance, adjust pending payouts

### Phase 3: Trust & Safety (Days 6–7)

10. **Dispute resolution** — Full lifecycle from §5.4 with deadlines and auto-escalation
11. **Return requests** — Per-sub-order returns with vendor approval workflow
12. **Vendor reviews** — Review CRUD, verified purchase check, vendor response, aggregate rating
13. **Vendor documents** — Upload, admin review, verification status
14. **Performance scoring** — Composite score from defect rate, shipping speed, ratings, cancellations

### Phase 4: B2B (Days 8–9)

15. **RFQ system** — Create, bid, shortlist, award workflow
16. **Contract pricing** — Negotiated prices resolved during checkout via hook
17. **B2B plugin options** — Feature flags for RFQ and contract pricing

### Phase 5: Polish (Day 10)

18. **Webhook events** — All events from §9 wired to core webhook system
19. **MCP tools** — All tools from §10
20. **Integration tests** — Full lifecycle: vendor onboard → list product → customer buys → sub-order fulfilled → payout → review → dispute → return
21. **Plugin dist rebuild**

---

## 12. Migration Strategy

Since RFC-002 already moved the plugin to Drizzle queries, migration is additive:

1. New columns on existing tables use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` with defaults
2. New tables are created via `drizzle-kit push`
3. Existing vendor data retains current structure; new fields default to null/empty
4. No breaking changes to existing endpoints — all new functionality is additive
5. Existing `POST /vendors`, `PATCH /vendors/:id`, `POST /vendors/:id/approve` continue to work unchanged

---

## 13. What This Covers vs. What It Doesn't

### Covered (~90% of marketplace needs)

- Full vendor lifecycle (register → verify → approve → active → suspend → reinstate)
- Multi-model commission (flat, category, tier, volume, promotional)
- Sub-order fulfillment with state machine and tracking
- Vendor self-service portal
- Financial ledger with balance tracking
- Scheduled payouts with holdback and minimums
- Dispute resolution (3-stage: self-service → vendor → platform)
- Per-vendor returns and RMA
- Vendor reviews and ratings
- Performance scoring and automated enforcement
- B2B: RFQ and contract pricing
- Webhook events for all state transitions
- MCP tools for AI agent integration

### Not Covered (future RFCs)

- **Split payment integration** (Stripe Connect, PayPal Marketplace) — requires payment adapter extension, not plugin scope
- **Buy Box algorithm** — requires product-level multi-vendor offers table, complex ranking logic
- **Fulfillment-by-platform** — requires warehouse management module beyond marketplace scope
- **Vendor storefront theming** — frontend concern, not headless backend
- **Real-time inventory sync** — WebSocket/SSE infrastructure, separate RFC
- **ML recommendations** — external service integration
- **Punchout catalog (cXML/OCI)** — enterprise integration, separate plugin
- **Multi-currency payout conversion** — requires FX rate service integration

---

## 14. Key Files

| File | Change Type |
|------|-------------|
| `packages/plugins/plugin-marketplace/src/schema.ts` | MODIFY (extend tables, add 8 new tables) |
| `packages/plugins/plugin-marketplace/src/index.ts` | REWRITE (wire services, routes, hooks) |
| `packages/plugins/plugin-marketplace/src/services/vendor.ts` | NEW |
| `packages/plugins/plugin-marketplace/src/services/sub-order.ts` | NEW |
| `packages/plugins/plugin-marketplace/src/services/commission.ts` | NEW |
| `packages/plugins/plugin-marketplace/src/services/payout.ts` | NEW |
| `packages/plugins/plugin-marketplace/src/services/dispute.ts` | NEW |
| `packages/plugins/plugin-marketplace/src/services/return.ts` | NEW |
| `packages/plugins/plugin-marketplace/src/services/review.ts` | NEW |
| `packages/plugins/plugin-marketplace/src/services/rfq.ts` | NEW (B2B) |
| `packages/plugins/plugin-marketplace/src/services/contract-price.ts` | NEW (B2B) |
| `packages/plugins/plugin-marketplace/test/marketplace.test.ts` | REWRITE |
