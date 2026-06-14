# Changelog

All notable changes to Porulle.

## [0.5.0] - 2026-06-14

First release out of alpha. Closes all 29 open issues from the 0.1.0 alpha, plus a full-monorepo green sweep. All `@porulle/*` packages move to 0.5.0 together.

### Added

- **`auditMiddleware(kernel)`** — one `commerce_audit_log` row per successful (2xx) state-changing request, with handler overrides (`auditEvent`/`auditEntityId`/`auditSkip`); audit-by-default with no per-route boilerplate.
- **`parseJson(c, schema)` + `err(c, …, details?)`** — validated body parsing that returns a 422 carrying `details.issues[]`; the error envelope is documented in OpenAPI. Client-side `isApiError` / `mapApiErrorToFields` in `@porulle/sdk` flatten it to form-field errors.
- **`getSchemaFiles()` / `pushSchema(db)`** exported from `@porulle/core` — the documented programmatic schema-management path for npm consumers.
- **`noopStorageAdapter` default** — `defineConfig` boots with no `storage` configured (catalog-only deploys); media uploads return `501 storage_not_supported` until a real adapter is set.
- **`server.runJobs()`** — public job-runner tick for serverless cron (`scheduled()` on Workers).
- **`runtime.getClientIp`** config seam — resolve the rate-limit key from a platform header on edge runtimes (`cf-connecting-ip`, `x-real-ip`, `fly-client-ip`).
- **`PromotionType`** union + OpenAPI enum exported; single-sourced from the promotions schema.
- **REST surface**: `GET /api/orders/lookup` (fuzzy receipt-less lookup), `GET /api/customers/:id/orders?include=totals` (lifetime-spend rollup), `POST /api/customers` walk-in/userId-less creation, `PATCH /api/promotions/:id`, inventory `adjust` `mode=add|remove|set` with `{before, after, delta}`, category `status` + archive/restore, and a `customer_interactions` table with CRUD.
- **Guides**: `docs/best-practices.md` (day-one principles) and `docs/deploy-cloudflare-workers.md` (lazy per-isolate config, environment-aware DB adapter, cron).

### Fixed

- **Auth**: `verifyApiKey` now forwards the key's `configId`, so API keys minted under named (non-`default`) scopes authenticate instead of silently 401-ing.
- **Packaging**: `@better-auth/api-key` declared as a runtime dependency of `@porulle/core`; `@porulle/cli` no longer ships `workspace:*` deps (lazy-loaded, `optionalDependencies`); the README quick-start targets the real `/api/catalog/*` surface.
- **Media**: `POST /api/media/upload` is exempt from the global 1MB body limit (`config.media.maxUploadSize`, default 10MB).
- **Edge/Workers**: `db.execute()` returns a uniform row array across postgres-js / neon-http / node-postgres / PGlite.
- **PATCH `/api/customers/:id`** shallow-merges `metadata` by default (`?metadataReplace=true` to overwrite).
- `store-example` seed/full-flow scripts pass the required `actor` to catalog mutations (were broken at runtime).

### Changed

- **Status: alpha → beta.** All `@porulle/*` packages versioned at 0.5.0.

## [Unreleased]

### Removed

- **Unused `mergeExtraColumns` / `ExtraColumnsOption` / `PaymentAdapter.extraColumns`** — never wired up. The `@unifiedcommerce/core/schema-utils` sub-path export is removed. If you depended on these, raise an issue.

### Added

- **`@unifiedcommerce/core/schema` sub-path export** — import any core Drizzle table (`sellableEntities`, `customers`, `orders`, etc.) without triggering ESM barrel issues. Use for FK references in app-level schema files.
- **`@unifiedcommerce/core/auth-schema` sub-path export** — Better Auth tables (`user`, `session`, `account`, etc.) available as a direct import.
- **`schema` config field** — define new tables and extended columns directly in `commerce.config.ts` without wrapping in a plugin. Entries are merged into `customSchemas` alongside plugin schemas.
- **`buildSchema(config)`** — merges core schema with all plugin + app-level schemas. Throws on name collisions.
- **Per-app `drizzle.config.ts`** — each app owns its own Drizzle config with explicit module schema paths, avoiding ESM barrel issues with `drizzle-kit`.
- **Foreign key support** — app/plugin schema files can reference core tables for real FK constraints via `@unifiedcommerce/core/schema`. Loyalty and reviews tables use `ON DELETE CASCADE` / `SET NULL`.
- **DB scripts** for store-example: `db:push`, `db:pull`, `db:generate`, `db:migrate`, `db:studio`, `db:reset`, `setup`.
- **Loyalty plugin (DB-backed)** — `loyalty_points` and `loyalty_transactions` tables with proper FKs to `customers`. Hooks (`orders.afterCreate`) award points, upsert totals, and calculate tier progression (bronze/silver/gold/platinum). REST routes for points lookup, leaderboard, and redemption. Resolves customer identity via UUID or user_id.
- **Reviews table & routes** — app-level custom table with FK references to `sellable_entities` and `customers`, plus REST routes for CRUD, FK-joined queries, aggregation summaries, and moderation. Registered via `config.routes` — no plugin needed.
- **Supplier info routes** — REST routes for querying/updating extended columns (`supplier_code`, `country_of_origin`) on `sellable_entities`. Demonstrates extending a core table’s column set end-to-end.
- **Extended catalog schema** — demo adding `supplier_code` and `country_of_origin` to `sellable_entities` via an app-level Drizzle table definition.
- **`CustomerService.getById()`** — direct profile UUID lookup without auto-creation (complements existing `getByUserId()` which auto-creates).
- **Checkout customer identity resolution** — tries profile UUID first (`getById`), falls back to Better Auth user_id (`getByUserId`). UUID validation prevents Postgres type errors on non-UUID strings.
- **`database` exposed on service container** — plugin hooks can access DB via `context.services.database.db` for direct Drizzle queries.
- **`auth.trustedOrigins` config** — passes through to Better Auth `trustedOrigins` for CSRF protection. Eliminates the need for manual `Origin` header hacks in scripts and API clients.
- **`demo:simulate` script** — 5-scenario end-to-end simulation: supplier info setup, customer browse→buy→review, repeat buyer loyalty progression, review moderation/summaries, cross-cutting leaderboard and inventory checks.
- **Shared `signUp()` and `resetSession()` helpers** — demo scripts can register users and switch between sessions without duplicating auth logic.

### Fixed

- **Customer portal 403** — checkout now correctly links orders to customer profile UUIDs. `/api/me/orders` and `/api/me/orders/:id` return the customer's orders instead of empty/forbidden.
- **Loyalty route 500 on non-UUID customer IDs** — UUID regex validation before querying UUID columns; falls through to `getByUserId` resolution.
- **drizzle-kit ESM error** — per-app config uses explicit module schema paths instead of the core barrel which chains to ESM-only `@better-auth/drizzle-adapter`.
- **Duplicate index collision** — extended catalog schema no longer re-declares indexes already defined by the core `catalog/schema.ts`.
- **Better Auth CSRF rejection on scripts** — configured `trustedOrigins` in auth setup; added `Origin` header to shared `_helpers.ts` `api()` and `signIn()` functions. Removed duplicated `authFetch` hack from simulation script.

---

## [0.0.1] — 2025-12-01 through 2026-03-12

### Foundation

- Monorepo scaffolding via Turborepo (apps, packages, plugins).
- **Core engine** (`@unifiedcommerce/core`): kernel, config system (`defineConfig`), hook executor, plugin manifest (`defineCommercePlugin`), permission system, result types (`Ok`/`Err`).
- **Drizzle ORM schema** for: catalog (entities, attributes, custom fields, categories, brands, variants), inventory (levels, locations, adjustments), cart (carts, line items), orders (orders, line items, status history), customers (profiles, addresses), pricing (price lists, entries), promotions (discounts, usage tracking), fulfillment (records, line items, events), media (assets, entity associations), webhooks, audit log, jobs queue.
- **REST API** via Hono: full CRUD for catalog, inventory, cart, orders, customers, pricing, promotions, fulfillment, media, webhooks, search, analytics, health, auth (Better Auth).
- **Hook system** — before/after hooks on all CRUD operations. Checkout pipeline: `validateCartNotEmpty` → `resolveCurrentPrices` → `checkInventoryAvailability` → `applyPromotionCodes` → `calculateTax` → `calculateShipping` → `validatePaymentMethod` → `authorizePayment` → `completeCheckout` → `recordAnalyticsEvent`.
- **Plugin architecture** — `defineCommercePlugin()` with schema, hooks, routes, MCP tools, and analytics models. Config transform pattern (PayloadCMS-inspired).
- **MCP server** — Model Context Protocol endpoint for AI agent integration.
- **Search module** — adapter-based search with facets, suggest, and indexing hooks.
- **Analytics module** — event recording, revenue/inventory/customer metrics, pre-aggregation.
- **Tax module** — adapter-based tax calculation with transaction reporting.
- **Shipping module** — flat rate and weight-based calculators with free shipping threshold.

### Adapters

- `@unifiedcommerce/adapter-postgres` — PostgreSQL adapter via `postgres.js` + Drizzle.
- `@unifiedcommerce/adapter-sqlite` — SQLite adapter via `better-sqlite3` + Drizzle.
- `@unifiedcommerce/adapter-local-storage` — local filesystem media storage.
- `@unifiedcommerce/deployment-vercel` — Vercel deployment adapter.

### Plugins

- **POS plugin** (`@unifiedcommerce/plugin-pos`) — session management, barcode scanning, tender/void/receipt, PIN auth, MCP tools.
- **Marketplace plugin** (`@unifiedcommerce/plugin-marketplace`) — multi-vendor support with vendor scoping, commission calculation, payout tracking.

### Testing

- **PGlite-backed test infrastructure** — real PostgreSQL semantics in tests via `@electric-sql/pglite`. Replaces in-memory repos for integration tests.
- 107+ integration tests across cart/checkout/orders, robustness, hooks, config, pricing/promotions/tax/shipping, analytics, search, plugins.
- REST API integration tests for all modules (carts, catalog, inventory, orders, customers, pricing, promotions, fulfillment, media, webhooks, search, health).

### Store Example

- `apps/store-example` — full reference app with Acme Streetwear demo store.
- Better Auth integration with API keys, role-based access (owner, admin, staff, customer, ai_agent), POS PIN auth.
- Seed script with 7 products (variants, pricing, inventory across 2 locations), gift card, sample customer, promotion code.
- Demo scripts: `demo:all`, `demo:browse`, `demo:cart`, `demo:inventory`, `demo:analytics`, `demo:admin`, `demo:customer`, `demo:loyalty`.
- Customer portal routes (`/api/me/*`) with ownership-scoped order access.

### Key Bug Fixes

- **null vs undefined for variantId** — Drizzle returns `null` for nullable columns; use `!= null` (loose equality) to catch both. Never pass `null` to Drizzle's `eq()`.
- **Better Auth schema setup** — generated auth tables pushed via drizzle-kit; `drizzleAdapter()` receives `schema: authSchema`.
- **Actor userId vs Customer Profile UUID** — Better Auth `actor.userId` is a string ID; `orders.customer_id` stores the customer profile UUID. Resolution via `getByUserId()` auto-creation.
- **Promotions date coercion** — JSON string dates coerced to `Date` objects before Drizzle insert.
- **Order state machine** — valid transitions: `pending → confirmed → processing → [partially_fulfilled | fulfilled] → refunded`.
- **PGlite transaction hanging** — fixed checkout flow in test infrastructure.
