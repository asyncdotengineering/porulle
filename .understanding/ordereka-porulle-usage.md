# Ordereka Fashion POS — How It Uses (and Bypasses) Porulle

Explored: `/Users/mithushancj/Documents/asyncdot/openscoped/ordereka/ordereka-fashion-pos` (186 commits, live on Cloudflare).
Compared against: porulle repo at `/Users/mithushancj/Documents/asyncdot/rnd/venture-sell/porulle-suite/porulle` (0.7.0 + unreleased #40–#46 fixes).
Date: 2026-07-02. Read-only pass; no code modified.

---

## 1. Primitive

A live single-store fashion POS that uses porulle 0.1.0 as **boot chrome** (server factory, auth, adapters, config, schema push) while reimplementing nearly the entire commerce write-path — checkout, refunds, exchanges, inventory, reports — as ~5,200 LOC of raw-Drizzle Hono routes mounted through porulle's `routes()` escape hatch, writing directly into porulle's own tables.

## 2. Map at a glance

- **Porulle exercised:** `createServer()`, `defineConfig()`, Better Auth (API keys, roles, scopes), `postgresAdapter`/`localStorageAdapter`, `schema: [allTables]` extension, `entities.product` variants config, giftcards plugin, media upload service, audit service (once), OpenAPI. (`apps/api/commerce.config.ts:1-170`, `apps/api/src/server.ts:13-14`)
- **Porulle bypassed:** cart, checkout, orders, payments, inventory movement, promotions application, pricing — all reimplemented as **95 custom endpoints** in one 4,390-line file (`apps/api/src/routes/index.ts`) that imports porulle's Drizzle tables from `@porulle/core/schema` and queries them raw (`routes/index.ts:14-30`). Kernel services are used exactly **once** (`kernel.services.audit.record`, one call site in routes/index.ts).
- **The team is the upstream:** ordereka filed porulle issues #1–#23; porulle's own git history shows them all fixed by 0.5.0 (e.g. `18512df feat(core): fuzzy order lookup (#4)`, `8760cd0 fix(auth): forward configId in verifyApiKey (#1)`). The app still pins 0.1.0, so every one of those fixes is a live workaround in this codebase.
- **20 custom Drizzle tables** beside porulle's (shifts, held sales, layaways, custom orders, order payments/multi-tender, order notes, vouchers, measurements, wishlists, visits, expenses, cash movements, store settings, VAT sequences, media links…) — `apps/api/src/schema/index.ts` (546 LOC).
- **Client side:** offline sale queue + idempotency-key replay (`apps/pos/lib/offline-queue.ts`), thermal receipt/label byte rendering (`packages/receipt/`), localhost print bridge (`apps/print-companion/`), Tauri desktop shell with OTA served off R2 through custom worker routes (`apps/api/src/worker.ts:85-100`).

## 3. How porulle is used (top-down)

**System boundary.** One Cloudflare Worker API (`apps/api/src/worker.ts:108-127` — `fetch` + `scheduled` handlers) + two Pages front-ends (POS on Expo/RN-web, admin on Vite/React) + a Tauri desktop POS + a localhost print companion. DB is Neon Postgres (optionally via Hyperdrive), media on R2. Deploy table in `HANDOFF.md` ("Deployed state": ordereka-api.mithushancj.workers.dev, ordereka-{admin,pos}.pages.dev).

**Composition.**
- `apps/api/src/server.ts:13-14` — `buildConfig()` → `createServer(config)` from `@porulle/core`; node dev entry. `apps/api/src/worker.ts:41-106` — same, cached per isolate, with two adapter overrides injected.
- `apps/api/commerce.config.ts:25-169` — `defineConfig` carries the real porulle surface used: `plugins: [giftCardPluginWithHooks(...)]` (line 30), `databaseAdapter: postgresAdapter(...)` (31), `storage: localStorageAdapter(...)` (35), `email: consoleEmailAdapter()` (39), full Better Auth block (41-150: apiKeys + apiKeyScopes + roles), `entities.product` with `variants: { enabled: true, optionTypes: ["color","size"] }` (152-162), `schema: [allTables]` (164), and `routes: (app, kernel) => registerOrderekaRoutes(app, kernel)` (166-168).
- **Everything domain-shaped enters through that one `routes()` hook.** `registerOrderekaRoutes` (`apps/api/src/routes/index.ts`) treats `kernel` as `{ database: { db: unknown } }` (line 70) — i.e. porulle is used as a *database handle provider*, not a service layer.
- Auth for custom routes: porulle's middleware hydrates `c.get("actor")`; the app layers its own `requireScope`/`hasPerm` RBAC on top (`apps/api/src/routes/helpers.ts:227-260`) with a `ROLE_PERMISSIONS` map that **duplicates** the config roles ("Mirrors auth.roles from commerce.config.ts", `routes/index.ts:75`).
- Better Auth instance is smuggled to routes via a module-global holder because "`config.routes(app, kernel)` doesn't receive `auth` — the kernel type explicitly excludes it" (`apps/api/src/runtime/auth-holder.ts:1-11`).

**Porulle REST actually consumed by clients** (vs custom): `/api/customers/:id` (implementation-notes.md:155-157), `/api/media/upload` + `/api/media/attach` ("porulle's built-in POST /api/media/upload + attach", `packages/api-client/src/hooks/index.ts:911,936`), catalog/product CRUD + promotions CRUD (HANDOFF.md §4-5), health/OpenAPI (`server.ts:27-28`). The POS hot path (`/api/pos/*`, checkout, refunds, shifts) never touches porulle REST.

Confidence: **high** (all file:line verified).

## 4. Why pinned to 0.1.0

- The pin (`"@porulle/core": "0.1.0"` in root `package.json` `overrides` + `resolutions`, lines 23 & 31) has existed since the **initial commit** `b99be0f` ("Initial: Ordereka fashion POS — API + Admin + POS") — confirmed via `git log -S'"overrides"' -- package.json` (single hit).
- No doc states the porulle pin's rationale explicitly. The adjacent pins are explained: "Pinned `react`, `react-dom`, `babel-preset-expo` in root `overrides` + `resolutions` to force a single resolution" (implementation-notes.md:336). The porulle pin most plausibly serves the same dedupe purpose — `@porulle/plugin-giftcards` and `apps/api` must share one `@porulle/core/schema` instance or Drizzle table identities diverge. **Confidence: medium (inference).**
- Consequence is documented: "Several runtime shims in `apps/api/src/runtime/` exist solely until porulle ships the relevant upstream fixes (issues #10–#15)" (PROJECT_KT.md:118) — those fixes shipped (porulle commits `f0e1ddb` #10, `b41a36b` #11, `ccada83` #13, `fa2aac7` #15) but the app never upgraded off 0.1.0.

## 5. Hand-rolled inventory

LOC figures are estimates from route spans in `apps/api/src/routes/index.ts` (4,390 LOC total) unless another file is named. Classification legend: **PG** = PORULLE-GAP (belongs in core, still missing at 0.7.0), **VL** = VERSION-LAG (hand-rolled against 0.1.0; current porulle has it), **DS** = DOMAIN-SPECIFIC.

| # | Capability | Where (file:line) | LOC est | Class | Evidence / why | Core-promotion priority |
|---|---|---|---|---|---|---|
| 1 | POS checkout (totals, discount, multi-tax pro-rate, split tender, gift-card redeem, inventory decrement, idempotency) | routes/index.ts:1130-1465 (`POST /api/pos/checkout`) | ~340 | PG | Bypasses porulle cart/orders entirely; raw inserts into `ordersTable`+`orderLineItems`+`orderPayments`. 0.7.0 added `POST /orders`+capture+refund (CHANGELOG.md) but no POS-grade checkout w/ idempotency+tender+tax | **High** |
| 2 | Idempotency-key replay for offline retries | routes/index.ts:1167-1186 ("POS offline queue retries on reconnect, which would otherwise double-charge") | ~25 | PG | No idempotency primitive anywhere in porulle core | **High** |
| 3 | Line-level partial refunds + daily refund cap + refund **undo** | routes/index.ts:1466-1888 (`/api/refund-cap/today`, `POST /orders/:id/pos-refund`, `/refund/undo`) | ~420 | PG (partially VL) | 0.7.0 has `POST /orders/{id}/refund`; cap policy, line-level `metadata.refundedQuantity`, and undo are still gaps | **High** |
| 4 | Exchanges (return + replacement order in one op) | routes/index.ts:3421-3480 (`POST /api/exchanges`) | ~60 | PG | Raw insert of a new confirmed order; no exchange concept in porulle | High |
| 5 | Order void | routes/index.ts:3539-3561 | ~25 | PG | Sets `status: "voided"` directly on porulle's orders table | Med |
| 6 | Multi-tender payments table + payment listing | schema/index.ts:310 (`order_payments`), routes/index.ts:1889-1898 | ~80 | PG | "Payment method: computed from `order_payments`, not `metadata.method`" (HANDOFF.md "Things to NOT redo"); tender enum incl. cash/card/qr/koko/gift/credit/bank (routes/index.ts:106) | **High** |
| 7 | Receipts: HTML renderer + A4 PDF invoice + print/email/whatsapp actions + VAT invoice sequences | routes/receipt-template.ts (225), routes/invoice-pdf.ts (331, pdf-lib on Workers), routes/index.ts:1899-2079, schema/index.ts:482 (`vat_invoice_sequences`) | ~800 | PG | No document/receipt generation in porulle at all | **High** |
| 8 | Shifts / register sessions (open w/ float, expected-drawer calc, EOD close w/ variance gate, per-shift API key mint+revoke) | routes/index.ts:893-1076; schema/index.ts:62 | ~250 | PG (POS core) | Per-shift Better Auth API keys minted via `auth.api.createApiKey` through the auth-holder shim | High (as POS plugin) |
| 9 | Held sales (park/resume) + TTL expiry cron | routes/index.ts:1077-1129, 3523-3538; runtime/cron.ts; schema/index.ts:92 | ~150 | PG (POS core) | cron.ts:10-12: "Why not porulle's full job runner? Two recurring tasks don't justify the cost of wiring `kernel.services.jobs`" | Med |
| 10 | Layaways (partial-payment plans, derived status) + custom-order flow w/ fittings & payments | routes/index.ts:2508-2647, 3481-3522; schema tables layaways/layawayPayments/customOrders/customOrderFittings | ~250 | PG/DS split | Layaway = generic retail; fittings = fashion-specific | Med |
| 11 | Cash movements + expenses (drawer ledger, P&L feed) | routes/index.ts:2648-2748; schema:222,243 | ~120 | PG (POS core) | — | Med |
| 12 | Reports suite: dashboard KPIs, daily journal, tax summary, P&L, activity, stock, inventory-aging, sell-through, reorder-needed, staff | routes/index.ts:3014-3420, 3908-3960, 4038-4390 | ~1,000 | PG | porulle has an `analytics` module dir but nothing this shaped; every report is raw SQL over porulle tables | **High** |
| 13 | Dashboard range parser w/ store-timezone calendar math + prior-period deltas | routes/helpers.ts:80-224 (hardcoded UTC+5:30: "Sri Lanka is UTC+05:30… If the store ever opens a second tenant in another zone, this becomes a per-org setting") | ~150 | PG | Store-timezone reporting is universal | Med |
| 14 | PIN login → per-shift API key, manager override w/ PIN, staff CRUD w/ scrypt PIN hash | routes/index.ts:680-892, 4022-4037; helpers.ts:8-27 | ~300 | PG (POS core) | Better Auth has no PIN concept; app mints synthetic per-shift keys | High (as POS plugin) |
| 15 | RBAC permission check layer duplicating config roles | routes/index.ts:73-101 + helpers.ts:241-260 | ~90 | VL-ish | porulle's middleware hydrates actor but exposes no `requirePermission` helper to custom routes; duplication is drift-prone | Med |
| 16 | Store settings singleton (VAT rates, tax classes, refund cap, held-sale TTL, receipt branding, logo upload) | routes/index.ts:776-828; schema:346 (`store_settings`) | ~120 | PG | No settings/branding module in porulle | High |
| 17 | Multi-tax-class line-level calc (label→bp map, cart discount pro-rated across lines) | routes/index.ts:1196-1230 (S11, commit `dc8b91b`) | ~60 | PG | porulle has a `tax` module dir; this per-line class calc was still hand-rolled | Med |
| 18 | Customer clienteling: visits log, wishlists (+queue), measurements, lifetime stats, attach/detach customer to order | routes/index.ts:2130-2177, 2749-3013; schema:285,431,455 | ~400 | VL (visits: porulle `e7865f4` #3) + PG (wishlist, measurements, order attach) | implementation-notes.md:168: "Clienteling is universal across retail verticals" | Med |
| 19 | Walk-in customer creation (no email/user) | routes/index.ts:2354-2380 (`POST /api/pos/customers`) | ~30 | **VL** | Fixed upstream: `efe386a feat(core): POST /api/customers supports walk-in / userId-less creation (#5)` | — (done) |
| 20 | Fuzzy order lookup (receipt-less returns) | routes/index.ts:2935-2972 (`/api/pos/lookup-orders`) | ~40 | **VL** | Fixed upstream: `18512df feat(core): fuzzy order lookup GET /api/orders/lookup (#4)` | — (done) |
| 21 | Customer orders + lifetime totals rollup | routes/index.ts:2749-2761 | ~15 | **VL** | Fixed upstream: `5be7f42 (#2) ?include=totals` | — (done) |
| 22 | Inventory adjust w/ mode=add\|remove\|set, clamp-at-zero, before/after/delta | routes/index.ts:3852-3907 (`POST /api/inventory/adjustments`) | ~60 | **VL** | Fixed upstream: `1c7ade2 (#7)`; implementation-notes.md:172 quotes the wrapper rationale | — (done) |
| 23 | PATCH promotions, PATCH customers w/ metadata merge, category archive, PromotionType enum | routes/index.ts:3961-4021 (+admin `metadata.archived` soft-delete, HANDOFF.md §5) | ~100 | **VL** | Upstream `aad8d26` #6, `c6c3f98` #8, `527c2b9` #22, `7911c6c` #23 | — (done) |
| 24 | `parseJson` + 422 `details.issues[]` error envelope | helpers.ts:36-75 | ~45 | **VL** | Upstream `3314ee9 feat(core,sdk): parseJson() + details.issues[] envelope (#17)` | — (done) |
| 25 | `apiKeyScopes.default` naming hack (named-scope keys verified as unauthenticated otherwise) | commerce.config.ts:64-69 ("Porulle's auth middleware calls `verifyApiKey({ key })` without a `configId`… every per-shift API key verifies as unauthenticated") | ~5 | **VL** | Fixed upstream: `8760cd0 fix(auth): forward configId in verifyApiKey (#1)` | — (done) |
| 26 | Hyperdrive/Neon hybrid DB adapter (HTTP for simple queries, fresh WS Pool per transaction) | runtime/hyperdrive-adapter.ts (97 LOC; header documents ~30% flake on shared Pools, neon-http lacking transactions) | ~100 | PG (partially VL: #10/#11 landed) | A first-party `@porulle/adapter-neon`/Workers adapter is still missing; docs commit `e8e251d` only adds a *recipe* | **High** |
| 27 | R2 storage adapter | runtime/r2-storage.ts (81 LOC, "Mirrors localStorageAdapter but persists to a Cloudflare R2 bucket") + worker.ts:65-79 asset serving w/ CORS for canvas rasterization | ~110 | PG | No `@porulle/adapter-r2` exists in porulle repo (`ls packages/adapters` — postgres/local-storage only; unverified list, see §11) | **High** |
| 28 | Serverless cron (Workers `scheduled()` → tick fn) | worker.ts:114-126 + runtime/cron.ts | ~100 | VL (mechanism) / PG (tasks) | `fa2aac7 feat(core): expose server.runJobs() for serverless cron (#15)` gives the hook; TTL/expiry jobs remain app-level | Med |
| 29 | Resend email adapter w/ attachments (invoice PDFs) | runtime/email.ts (69 LOC) | ~70 | PG | Core ships only `consoleEmailAdapter` (commerce.config.ts:1,39) | Med |
| 30 | Quick/bulk variant creation ("Porulle's API needs three separate calls (option type, option value, variant) and doesn't seed an inventory_levels row, so admin would otherwise stitch ~4 requests" — routes/index.ts:3556-3560), variant delete, by-SKU lookup, per-variant reorder points | routes/index.ts:3562-3840, 4258-4299 | ~350 | PG (0.7.0 improved `/variants/generate` errors only) | **High** |
| 31 | Product media link hydration (primary image per product/variant via own `media_assets`+`entity_media` joins) | routes/index.ts:2398-2507; schema:503,517 | ~110 | **VL** | 0.7.0 CHANGELOG: "`?include=media` is now backed by a real media/entity link lookup… instead of always returning []" | — (done) |
| 32 | Order notes CRUD + per-order audit timeline + prev/next neighbors | routes/index.ts:2080-2248; schema:410 (`order_notes` — "No FK to porulle orders.id (loose…) to avoid ESM cycle", rfcs/0003:288) | ~200 | PG | Order annotations are generic commerce | Med |
| 33 | Gift vouchers (own table + redemptions + expiry) **alongside** the giftcards plugin | schema:263 (`gift_vouchers`), 392 (`voucher_redemptions`); checkout redeems plugin's `giftCards` (routes/index.ts:1451-1453); cron expires `giftVouchers` | ~150 | PG (plugin gap) | Plugin lacked recipient/message/issuer/expiry semantics the store needed; two parallel voucher stores now exist | Med |
| 34 | POS product feed shaped for tills (flattened variants, stock, image, tax class) | routes/index.ts:2398-2507 (`/api/pos/products*`) | ~110 | PG | A read-model endpoint for POS catalogs | Med |
| 35 | Offline sale queue + sync screen + sync-report telemetry | apps/pos/lib/offline-queue.ts (134), apps/pos/app/(app)/sync.tsx, routes/index.ts:3841-3851 | ~250 | PG (client SDK gap) | offline-queue.ts:4-13 strategy note; pairs with #2 server idempotency | High (as SDK primitive) |
| 36 | Thermal receipt/label bytes (chittie ESC/POS + TSPL), print companion, cash-drawer kick, Tauri OTA channel | packages/receipt/ (383), apps/print-companion/, apps/pos/lib/hardware.ts (108), worker.ts:81-100; CHITTIE-*.md | ~700+ | **DS** | Hardware bridging is vertical-specific; porulle should stay out | Low |
| 37 | Fabric as a third variant axis (color×fabric×size) despite config declaring `["color","size"]` | commerce.config.ts:158 vs bulk-variants routes/index.ts:3662 & audit csv F008 | — | DS | Fashion-specific | Low |
| 38 | Typed client hook layer (1,658 LOC TanStack Query hooks, hand-maintained) | packages/api-client/src/hooks/index.ts | ~1,660 | PG (SDK gap) | Exists because custom routes have no generated SDK; porulle's SDK covers only core REST | Med |

Confidence: **high** on rows 1-31 (each verified at cited lines); **medium** on LOC estimates and on rows 33, 38 interpretation.

## 6. Custom schema tables added (apps/api/src/schema/index.ts, 546 LOC)

20 `pgTable` definitions: `staff_profiles` (:39), `shifts` (:62), `held_sales` (:92), `layaways` (:129), `layaway_payments` (:158), `custom_orders` (:176), `custom_order_fittings` (:205), `cash_movements` (:222), `expenses` (:243), `gift_vouchers` (:263), `measurements` (:285), `order_payments` (:310), `store_settings` (:346), `voucher_redemptions` (:392), `order_notes` (:410), `customer_visits` (:431), `customer_wishlists` (:455), `vat_invoice_sequences` (:482), `media_assets` (:503), `entity_media` (:517). Registered via `schema: [allTables]` (commerce.config.ts:164) — the schema-extension hook is one porulle surface that clearly worked. RFC 0001:195: "No changes to porulle's schema. All additions live in apps/api/src/schema/index.ts or as new metadata keys." Note: `media_assets`/`entity_media` appear to re-declare porulle-side media concepts locally (cf. porulle test commit `ca728ff` "pin media + audit schema re-exports from /schema (#20)") — see open questions.

## 7. Plugins written in-app

**None.** `apps/api/src/plugins/` is empty (verified `find … -type f` → no output). The only plugin used is upstream `@porulle/plugin-giftcards` (commerce.config.ts:30). Everything custom went through `routes()` + `schema` instead of the plugin system — itself a signal: the plugin API was evidently not the path of least resistance for a real integrator.

## 8. Client-side workarounds (pos/admin)

- **Offline sale queue** — `apps/pos/lib/offline-queue.ts` (localStorage queue, drain on `online`, server idempotency completes the loop) + `apps/pos/app/(app)/sync.tsx` manual drain screen + `OfflineBadge.tsx`.
- **Receipt/label rendering client-side** — `packages/receipt/src/receipt.tsx` + `label.tsx` (chittie JSX→ESC/POS/TSPL bytes); `apps/pos/lib/hardware.ts` routes bytes to Tauri in-process print or the localhost companion.
- **Print companion** — `apps/print-companion/src/server.ts`: "Tiny localhost service that bridges the POS web app to a USB ESC/POS receipt printer + cash drawer" (WebUSB rejected: no Safari support, per-session gesture).
- **Manual media upload+attach orchestration** — `packages/api-client/src/hooks/index.ts:936-970` chains porulle's `/api/media/upload` then `/api/media/attach` client-side.
- **Categories faked via product metadata** — seeded from product metadata, soft-delete via `metadata.archived` (HANDOFF.md §5) because 0.1.0 had no category status (upstream #22, fixed `527c2b9`).
- **Admin ErrorBoundary** for silent render-crash unmounts (implementation-notes.md:161) — framework-agnostic but noted.

## 9. Pain quotes from docs/commits about porulle

- commerce.config.ts:56-58: "porulle wires these into Hono csrf({ origin }) which does EXACT matching (no wildcards). Multipart uploads (logo) therefore work from the production aliases… but NOT from Pages preview-hash URLs" (0.7.0 partially addressed: CSRF skipped for bearer requests).
- commerce.config.ts:65-69: "Porulle's auth middleware calls `verifyApiKey({ key })` without a `configId`… Without one, every per-shift API key verifies as unauthenticated."
- auth-holder.ts:2-4: "`config.routes(app, kernel)` doesn't receive `auth` — the kernel type explicitly excludes it."
- routes/index.ts:3556-3560: "Porulle's API needs three separate calls (option type, option value, variant) and doesn't seed an inventory_levels row, so admin would otherwise stitch ~4 requests."
- hyperdrive-adapter.ts:14-16: "`drizzle-orm/neon-http` does NOT support `db.transaction(fn)`… Checkout needs atomic order + lines + inventory" (why a bespoke DB adapter exists at all).
- implementation-notes.md:167-173: the seven upstream issue rationales, e.g. #2 "Every commerce admin needs the lifetime-spend rollup; we shouldn't fork the endpoint", #4 "The receipt-less-return pattern is universal; every POS app reinvents it", #5 "every retail integration mints a synthetic Better Auth user as a side-effect", #8 "Universal pain across every commerce admin."
- PROJECT_KT.md:118: "Several runtime shims in `apps/api/src/runtime/` exist solely until porulle ships the relevant upstream fixes (issues #10–#15)."
- PROJECT_KT.md:119 (vocab): porulle discount vocabulary confusion — `"percentage" | "fixed_amount"`, NOT `"percentage_off_order"` ("Commit `2fdc7b3` documents the detour").
- cron.ts:10-12: "Why not porulle's full job runner? Two recurring tasks don't justify the cost of wiring `kernel.services.jobs` + the `commerce_jobs` table."

## 10. Coupling hotspots + invariants

- **Schema-level coupling is the contract.** `routes/index.ts:14-30` imports 13 tables from `@porulle/core/schema` + `user` from `@porulle/core/auth-schema` and writes them raw (orders, line items, inventory levels/movements, variants, option types/values, customers, promotions, audit log). Any porulle schema migration breaks ordereka at the SQL level, not the API level. This is why the 0.1.0 pin is load-bearing.
- **Semantics encoded in metadata jsonb** on porulle rows: `orders.metadata.idempotencyKey` (routes/index.ts:1173), `order_line_items.metadata.refundedQuantity` (refund cap SQL, routes/index.ts:1478-1489), product `metadata.taxClass` / `metadata.cost` / `metadata.archived`. Invariant: porulle must never normalize/clobber consumer metadata.
- **`kernel.services` is almost unused** (1 audit call). The kernel's service layer failed to capture a production consumer; the DB handle did.
- **Auth duality**: porulle middleware authenticates; app authorizes (helpers.ts `requireScope`). Roles are declared twice (config + ROLE_PERMISSIONS map) — drift hazard the app itself flags.
- **Invariants the app relies on**: `kernel.database.db` is a Drizzle instance castable to `PostgresJsDatabase`; `commerce.auth` exposes Better Auth `api.createApiKey/deleteApiKey`; `actor` context var shape; `/assets` URL convention from the storage adapter; single-org (`org_default`) everywhere.
- **Test harness**: 40+ test files, ~270 test/it blocks under `apps/api/src/__tests__/` exercise the custom routes against the porulle-booted app — a de-facto conformance suite the framework team could mine.

## 11. Open questions

1. **Exact porulle-pin motivation** — inferred as workspace dedupe (§4); no doc states it. Ask the ordereka team (mithushancj) directly.
2. Are `media_assets`/`entity_media` in the app schema *duplicates* of porulle-core tables (re-declared because 0.1.0 didn't export them from `/schema`, cf. upstream #20) or genuinely distinct tables? Not resolved — requires diffing column shapes against 0.1.0's media schema.
3. `gift_vouchers` (custom) vs plugin `gift_cards`: checkout debits the plugin table (routes/index.ts:1451) while cron expires the custom table — is `gift_vouchers` dead/legacy or a second live flow (recipient-message vouchers)? Issuance route not read.
4. What porulle 0.2.0–0.6.0 shipped beyond the issue-fix commits — `packages/core/CHANGELOG.md` only has 0.7.0 notes and an empty 0.6.0 header, so VERSION-LAG rows 19-25/31 are grounded in commit messages, not release notes.
5. `apps/pos-desktop` (Tauri) internals and `packages/api-types` schema-fetch pipeline (`client:gen` script) — not read; whether the OpenAPI spec from porulle actually covers the 95 custom routes (they appear registered on the raw Hono app, likely **outside** the OpenAPI doc) is unverified.
6. Upgrade appetite: whether ordereka plans to move to 0.7.x and delete VL rows, or the raw-SQL coupling makes the upgrade cost prohibitive (the strongest argument for porulle shipping a stable service-layer API for POS write-paths).
