# Migrating from @porulle/core 0.1.0 to 0.7.x

**Who this is for.** Early adopters pinned to `@porulle/core` 0.1.0 whose
integration follows the "boot chrome" pattern: porulle provides the server
factory, auth, adapters, and schema push, while custom Hono routes (mounted
through `config.routes()`) write raw Drizzle into porulle's tables. If that's
you, your coupling to porulle is at the **SQL level**, so this guide leads
with the schema diff — what your raw queries will and won't notice — then
the behavioral changes, then the delete-list: every workaround the 0.2–0.8
line makes redundant.

The reference integration for this guide is ordereka-fashion-pos (the first
production adopter); the evidence-grounded map of its workarounds lives at
[`.understanding/ordereka-porulle-usage.md`](../.understanding/ordereka-porulle-usage.md).

---

## 1. The headline: the schema diff is 100% additive

`git diff` of every module schema between the 0.1.0 initial commit
(`df87882`) and 0.7.x+ shows **only additions** — new tables, new nullable
(or defaulted) columns, new indexes. **No table was renamed, no column was
dropped or retyped.** Raw SQL written against 0.1.0's tables keeps working
after the upgrade; `drizzle-kit push` (or your generated migrations) will
only CREATE and ALTER-ADD.

### New columns on existing tables

| Table | Column | Notes |
|---|---|---|
| `orders` | `idempotency_key` (text, null) | + partial unique index `(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. Replays of `POST /api/orders` / `POST /api/checkout` with the same key return the original order. |
| `order_line_items` | `is_custom_price` (boolean, default false) | Price-provenance marker. `true` means an `orders:manage` actor supplied a manual override; checkout and server-resolved catalog prices remain `false`. |
| `order_line_items` | `refunded_quantity` (int, default 0) | Maintained by the line-level refund REST (#52). If you tracked `metadata.refundedQuantity`, backfill this column once and delete the metadata hack. |
| `carts` | `email` (text, null) | Guest-cart contact for abandoned-checkout recovery (#43). |
| `categories` | `status` (text, default `'active'`) | Soft archive/restore (#22) — replaces `metadata.archived` hacks. |
| `sellable_entities` | `tax_class` (text, null) | Product tax class name (#57) — replaces `metadata.taxClass`. |
| `variants` | `tax_class` (text, null) | Variant-level override of the entity's class (#57). |

### New tables (all org-scoped, FK → `organization`)

| Table | Since | Feature |
|---|---|---|
| `customer_interactions` | 0.5.0 | Clienteling log (#3) — visits, calls, fittings, follow-ups. |
| `shipping_zones`, `shipping_rates` | 0.7.x | Runtime shipping config (#45); precedence over `defineConfig({shipping})`. |
| `tax_rates` | 0.7.x | Runtime region tax rates (#45); precedence over the tax adapter. |
| `tax_classes` | 0.8.0 | Product tax classes (#57): class → rateBps, `is_default` for unclassed lines. |
| `store_settings` | 0.8.0 | Org-scoped runtime settings (#49): `(org, group)` rows of shallow JSON. |
| `invoice_sequences`, `order_documents` | 0.8.0 | Fiscal invoice numbering + issued-document ledger (#47). |
| `order_refunds` | 0.8.0 | Line-level refund ledger (#52): daily cap + undo window. |
| `order_notes` | 0.8.0 | Operator annotations (#56), merged into the order timeline. |
| Plugin tables | 0.8.0 | `pos_operator_pins` (plugin-pos #51), `layaways` + `layaway_payments` (@porulle/plugin-layaway #58). |

**Migration mechanics.** Core ships no migration files by design — consumers
own their migrations. Regenerate against the new schema barrel
(`@porulle/core/schema`) with `drizzle-kit generate` (or `push` in dev), then
run `drizzle-kit check` to confirm no drift. Because the diff is additive,
the generated migration is CREATE/ALTER-ADD only.

---

## 2. Version history (backfilling the missing changelog)

The published `packages/core/CHANGELOG.md` starts at 0.7.0. What actually
shipped in between:

| Range | What it was |
|---|---|
| **0.1.0 → 0.5.0** | The early-adopter issue wave — all 29 rounds of ordereka feedback (#1–#29): configId forwarded in `verifyApiKey` so named-scope keys authenticate (#1), customer order totals rollup (#2), clienteling interactions (#3), fuzzy order lookup `GET /api/orders/lookup` (#4), walk-in customer creation (#5), `PATCH /api/promotions/{id}` (#6), inventory adjust `mode=add\|remove\|set` with before/after/delta (#7), customer metadata shallow-merge on PATCH (#8), custom DatabaseAdapter injection (#10), normalized `db.execute()` row shape across drivers (#11), injectable `runtime.getClientIp` (#13), `server.runJobs()` for serverless cron (#15), audit-by-default middleware (#16), `parseJson()` + `details.issues[]` error envelope (#17), CLI `make-key --ttl --user` (#18), media-upload body-limit exemption (#21), category archive/restore (#22), `PromotionType` export (#23), no-op StorageAdapter default (#27). 0.5.0 was the "out of alpha" release. |
| **0.5.0 → 0.6.0** | Packaging only: bun → pnpm migration, release-script fixes, CLI dep pinning. No schema or API changes. |
| **0.6.0 → 0.7.0** | Admin-panel gap fixes (#33–#38, see CHANGELOG): pricing upsert + `?include=pricing` identity, CSRF skipped for bearer/API-key requests, real `?include=media` hydration, `/assets` prefix fix, **draft order/capture/refund REST** (`POST /orders`, `/orders/{id}/capture`, `/orders/{id}/refund`), variants/generate 422 guard. |
| **0.7.0 → 0.8.0 (the field-study wave)** | #40–#46: fulfillments REST, pricing modifier CRUD, order line-item editing, cart list/recovery, runtime shipping/tax config, admin staff REST. Then #47–#58: settings module, documents (receipt/invoice + fiscal numbering), retail reports pack, one-call variants, PIN auth runtime, refund policy primitives, exchanges, offline SDK queue, `@porulle/adapter-neon`, order notes/timeline, tax classes, `@porulle/plugin-layaway`. Plus `config.routes(app, kernel, auth)` and public `requirePerm`. |

---

## 3. Behavioral changes to check before flipping the pin

Ordered by likelihood of touching a raw-Drizzle integration:

1. **`verifyApiKey` forwards `configId` (#1).** If you renamed a scope to
   `default` as a workaround, you can undo that — named scopes authenticate.
2. **`db.execute()` returns a row array on every driver (#11).** If you
   wrapped the driver to unwrap `{ rows }`, delete the shim.
3. **CSRF skips bearer/API-key requests (0.7.0).** Server-to-server calls no
   longer need Origin workarounds; browser cookie flows still enforce origin
   (exact match — Pages preview-hash URLs still need listing).
4. **`config.routes(app, kernel, auth)` (0.8.0).** The third argument is the
   Better Auth instance — module-global auth-holder shims can go.
5. **`requirePerm` is a public export (0.8.0).** Custom routes authorize with
   core's scope semantics instead of duplicated role maps.
6. **Storage defaults to a no-op adapter (#27)** — `createServer` boots
   without storage config; media routes 501 until a real adapter is set.
7. **Audit middleware runs by default on 2xx mutations (#16)** — expect rows
   in `audit_log` you didn't write.
8. **Checkout order lines now persist `tax_amount` / `discount_amount`**
   (0.8.0, #57) — previously always 0 unless you wrote them yourself.
9. **Metadata is never clobbered.** `PATCH /api/customers/{id}` merges (#8);
   nothing normalizes `orders.metadata` — keys like `idempotencyKey` written
   by old workarounds are untouched (but see the delete-list: the real
   column wins).
10. **Manual order creation is staff-only and server-safe.** `POST /api/orders`
    and `POST /api/orders/{id}/line-items` now require `orders:manage`.
    Direct service callers without that permission no longer control prices:
    core resolves the current catalog price and recomputes order totals. Add
    `orders:manage` to custom staff roles or API-key scopes that create manual
    orders; customer storefronts must continue through `POST /api/checkout`.

---

## 4. The delete-list: workaround → core feature

Each row is code the upgrade makes redundant. LOC estimates are from the
ordereka field study; "Since" names the release that shipped the replacement.

| Your workaround (ordereka reference) | Replace with | Since | ~LOC freed |
|---|---|---|---|
| Walk-in customer creation minting synthetic users | `POST /api/customers` userId-less (#5) | 0.5.0 | 30 |
| Fuzzy order lookup for receipt-less returns | `GET /api/orders/lookup?q=` (#4) | 0.5.0 | 40 |
| Customer lifetime totals rollup | `GET /api/customers/{id}/orders?include=totals` (#2) | 0.5.0 | 15 |
| Inventory adjust wrapper (clamp, absolute set, before/after) | `POST /api/inventory/adjust` `mode=` (#7) | 0.5.0 | 60 |
| Promotion PATCH / customer metadata-merge / category archive | Core PATCH endpoints (#6, #8, #22) | 0.5.0 | 100 |
| `parseJson` + 422 error envelope | Core `parseJson()` + `details.issues[]` (#17) | 0.5.0 | 45 |
| `apiKeyScopes.default` naming hack | configId fix (#1) | 0.5.0 | 5 |
| Visits/interactions table | `customer_interactions` + REST (#3) | 0.5.0 | ~100 |
| Serverless cron shim | `server.runJobs()` (#15) + Workers `scheduled()` | 0.5.0 | 100 |
| R2 storage adapter | `@porulle/adapter-r2` | 0.7.0 | 110 |
| Resend email adapter | `@porulle/adapter-resend` | 0.7.0 | 70 |
| Media link hydration joins | `?include=media` (0.7.0) | 0.7.0 | 110 |
| Draft order + capture + refund routes | `POST /orders`, `/{id}/capture`, `/{id}/refund` (#37) | 0.7.0 | ~200 |
| Idempotency-key replay via metadata | `idempotencyKey` on orders/checkout (0.8.0) | 0.8.0 | 25 |
| Module-global auth holder | `config.routes(app, kernel, auth)` | 0.8.0 | 15 |
| Duplicated ROLE_PERMISSIONS map | exported `requirePerm` | 0.8.0 | 90 |
| Store settings singleton table + routes | settings module (#49): `/api/settings`, `services.settings.read()` | 0.8.0 | 120 |
| Receipt HTML + PDF invoice + VAT sequences | documents module (#47): `GET /orders/{id}/invoice.pdf` etc. | 0.8.0 | ~800 |
| Reports suite (journal, tax, aging, sell-through, reorder, staff) + timezone parser | analytics reports pack (#48): `GET /api/analytics/reports/*` + `settings.general.timezone` | 0.8.0 | ~1,150 |
| Quick/bulk variant creation + inventory seeding | `POST /catalog/entities/{id}/variants/quick` + `/bulk` (#50) | 0.8.0 | ~350 |
| PIN login, per-shift keys, manager override, scrypt hashing | plugin-pos PIN runtime (#51) | 0.8.0 | ~300 |
| Line-refund tracking, refund cap, refund undo | refund policy primitives (#52) | 0.8.0 | ~420 |
| Exchange endpoint (raw order insert) | `POST /pos/exchanges` (#53) | 0.8.0 | 60 |
| Offline sale queue + sync screen plumbing | `@porulle/sdk` `OfflineQueue` (#54) | 0.8.0 | ~250 |
| Hyperdrive/Neon hybrid adapter | `@porulle/adapter-neon` (#55) | 0.8.0 | 100 |
| Order notes CRUD + audit timeline | `/orders/{id}/notes` + `/timeline` (#56) | 0.8.0 | ~200 |
| Multi-tax-class checkout calc from settings + `metadata.taxClass` | tax classes (#57): `/api/tax/classes` + `taxClass` columns | 0.8.0 | 60 |
| Layaways + layaway payments tables + routes | `@porulle/plugin-layaway` (#58) | 0.8.0 | ~250 |

Deliberately **not** upstreamed (keep yours): thermal receipt/label bytes,
print companion, cash-drawer hardware, Tauri OTA — hardware bridging is
vertical-specific.

---

## 5. Upgrade checklist

1. **Un-pin.** Remove the `@porulle/core` override/resolution from the root
   `package.json`; install the target version everywhere (one copy — the
   dedupe concern that motivated the pin is handled by matching versions
   across `@porulle/*` packages).
2. **Regenerate migrations** against the new schema barrel; review that the
   diff is CREATE/ALTER-ADD only (it should be — see §1); apply.
3. **Backfill** `order_line_items.refunded_quantity` from
   `metadata.refundedQuantity` and `sellable_entities.tax_class` from
   `metadata.taxClass` if you used those hacks, then stop writing the
   metadata keys.
4. **Walk §3** and delete each behavioral shim you carry.
5. **Work the §4 delete-list** one row at a time: swap the client call to
   the core endpoint, run your conformance tests, delete the custom route.
   Rows are independent — ship incrementally.
6. **Adopt the new config surface** where it replaces runtime tables you
   hand-rolled: `settings` groups for branding/policy knobs, `tax_classes`
   for VAT categories, `shipping_zones`/`tax_rates` for region config.
7. Run `pnpm exec drizzle-kit check` + your integration suite against a
   staging database before production.
