# @porulle/core

## 0.9.0

### Minor Changes

- Security hardening release. Multiple breaking changes — see `docs/migration-0.1-to-0.7.md`.

  **Tenant isolation (SEC-01–SEC-21):** symmetric scoped-db `update`/`delete`, org-scoped catalog/pricing/entity lookups, catalog cross-org write guards, raw-SQL org predicates, PIN-login org binding, analytics alias safety, and more.

  **Order creation:** server-priced by default (client prices ignored unless the actor holds `orders:manage`), tenant-integrity on line entities/variants, and `is_custom_price` provenance. **BREAKING:** `POST /api/orders` and `POST /api/orders/{id}/line-items` now require `orders:manage`; customers transact via `POST /api/checkout` (server-priced).

  **Inventory / IDOR / gift cards:** `POST /api/inventory/warehouses|reserve|release` now require inventory permissions (anonymous → 401, customer → 403); checkout idempotency-key replay is bound to the requesting customer (no cross-customer order leak); gift-card repository is org-scoped; new `order_line_items.is_custom_price` column.

  **Refund money-conservation:** total payout can never exceed the captured amount across `refundLines` + `changeStatus` (gross-refund cap incl. undone refunds); orders with refunded lines cannot be fulfilled; refunds are rejected on unpaid or terminal orders. **BREAKING:** refunds require a paid order.

  Migration: existing deployments must grant `orders:manage` to staff roles / API-key scopes that create manual orders, keep customers on `/api/checkout`, and apply the schema change (`is_custom_price`).

## 0.8.0

### Minor Changes

- 5c580c4: Resolves seven admin/operator API gaps (#40–#46): `POST /orders/{id}/fulfillments` (tracking + partial shipment), pricing-modifier list/patch/delete, order line-item editing with totals recalc, cart listing + abandoned-checkout recovery (`GET /carts`, `POST /carts/{id}/recover`, cart `email` column), runtime shipping zones/rates and tax rates with org-scoped CRUD REST applied at checkout (new `shipping_zones`, `shipping_rates`, `tax_rates` tables — consumers regenerate migrations), and admin staff/RBAC REST over the Better Auth member table (`/admin/staff*`). New permission scopes: `cart:manage`, `shipping:manage`, `tax:manage`, `staff:manage`.
- ae7c329: Order operations + retail tax + layaway from the ordereka field study (#56–#58). **Core:** order notes + activity timeline (#56) — `POST/GET/DELETE /api/orders/{id}/notes` (author, pinned-first ordering) and `GET /api/orders/{id}/timeline` merging status history, notes, and refund-ledger events (both directions) newest-first; new `order_notes` table. Product tax classes (#57) — `taxClass` is a first-class column on sellable entities and variants (variant overrides entity; writable on create/update), `/api/tax/classes` CRUD behind `tax:manage` (rateBps + `isDefault` for unclassed lines), and checkout computes per-line tax by class with cart-level discounts pro-rated across lines before tax; the order now stores per-line `taxAmount` (and `discountAmount`) from checkout. When an org defines classes they take precedence over region rates/adapter; new `tax_classes` table. **`@porulle/plugin-layaway`** (#58): partial-payment plans — create a plan from items (deposit % or amount, optional initial payment) which reserves stock while active; record installments in any tender; at full payment the plan completes automatically (core order created and cross-linked, stock hold released); forfeit releases the hold and runs the `onForfeit` policy hook. Consumers regenerate migrations (`order_notes`, `tax_classes`, `layaways`, `layaway_payments`, `sellable_entities.tax_class`, `variants.tax_class`).
- 157221c: Four retail-operations gaps from the ordereka field study (#47–#50): a **settings module** (org-scoped typed groups — general/branding/policies — with GET/PATCH `/api/settings` behind `settings:manage` and a `kernel.services.settings.read()` runtime API for plugins; new `store_settings` table); a **documents module** (HTML receipt + serverless-safe dependency-free PDF invoice rendered from an order at `GET /api/orders/{id}/invoice.pdf|invoice.html|receipt.html`, plus `POST /{id}/invoice/email`, with fiscal invoice numbers allocated atomically per org and issued idempotently per order — new `invoice_sequences` + `order_documents` tables); a **canned retail reports pack** (`GET /api/analytics/reports/*`: daily-journal, tax-summary, inventory-aging, sell-through, reorder-needed, staff-sales — calendar math in the store's `settings.general.timezone` with prior-period deltas, behind `analytics:read`); and **one-call variant creation** (`POST /api/catalog/entities/{id}/variants/quick` and `/bulk` upsert option axes inline, create variants, and seed a zero-stock `inventory_levels` row so variants are sellable immediately). Consumers regenerate migrations for the three new tables.
- f40b3d1: POS-grade money movement from the ordereka field study (#51–#53). **Core (#52):** line-level refund primitives — first-class `refundedQuantity` on order line items enforced by `POST /api/orders/{id}/refunds` (per-line refundable quantity), an optional per-operator daily refund cap read from `settings.policies.refundDailyCap` (403 with the cap surfaced; `GET /api/orders/refunds/cap` reports usage), and an audited undo window (`POST .../refunds/{refundId}/undo`, `policies.refundUndoWindowMinutes`, default 15) backed by a new `order_refunds` ledger table. Plugins can now receive the Better Auth instance (`PluginContext.auth`), contribute named API-key scopes via the manifest (`apiKeyScopes`), and scope definitions accept `keyExpiration` bounds; `createPluginTestApp` wires a real auth instance + middleware. **plugin-pos:** PIN auth runtime (#51) — `PUT /pos/auth/pin` (PBKDF2 via Web Crypto, Workers-safe), `POST /pos/auth/pin-login` minting a short-lived per-shift Better Auth API key under the plugin-registered `pos` scope, and `POST /pos/auth/override` for manager-by-PIN approvals (new `pos_operator_pins` table); exchanges (#53) — `POST /pos/exchanges` runs the return refund and the replacement order in ONE database transaction, cross-links refund/original/replacement, settles even exchanges immediately and leaves uneven ones open for tender. Consumers regenerate migrations (`order_refunds`, `pos_operator_pins`, `order_line_items.refunded_quantity`).
- 230f405: Two integrator quick wins from the ordereka-fashion-pos field study: `config.routes(app, kernel, auth)` now receives the Better Auth instance (no more module-global auth-holder shims) and `requirePerm` is a public export for authorizing custom routes; orders and checkout accept an `idempotencyKey` (new `orders.idempotency_key` column + unique org-scoped index — consumers regenerate migrations) so offline POS queues and network retries replay safely instead of double-charging — a checkout replay returns the original order without re-authorizing payment.

## 0.7.0

### Minor Changes

- Resolve admin-panel API gaps ([#33](https://github.com/asyncdotengineering/porulle/issues/33)–[#38](https://github.com/asyncdotengineering/porulle/issues/38)):

  - **Pricing**: `setBasePrice` now upserts on the natural key instead of appending a duplicate row, and `?include=pricing` exposes `id` + `createdAt` so consumers can identify the authoritative price.
  - **CSRF**: the global `csrf()` guard is skipped for API-key / bearer (server-to-server) requests, and genuine origin rejections surface a distinguishable `CSRF_ORIGIN_REJECTED` code.
  - **Catalog media**: `?include=media` is now backed by a real media/entity link lookup (role, sortOrder, url) instead of always returning `[]`.
  - **Local storage adapter / starter**: the `/assets/*` `serveStatic` mount strips the `/assets` prefix so adapter-generated URLs resolve correctly.
  - **Orders**: new REST endpoints for draft/manual order creation (`POST /orders`), payment capture (`POST /orders/{id}/capture`), and refund (`POST /orders/{id}/refund`).
  - **Variants**: `/variants/generate` documents its request body and returns a `422` for a missing/invalid strategy instead of a `500`.

## 0.6.0
