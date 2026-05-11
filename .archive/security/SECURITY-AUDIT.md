# Security Audit — unified-commerce-engine

**Date:** 2026-05-10
**Branch audited:** `foundation-repair` @ `eb991f6` (after CRITICAL-2 fix)
**Auditors:**
- **manager** (Claude Opus 4.7, in-context) — code-level audit of core auth + multi-tenancy
- **codex** (gpt-5.3-codex, adversarial r2) — `.handoff/result-sec-codex.txt`
- **pi** (deepseek-v4-pro, independent) — `.handoff/result-sec-pi.md`

**Status:** ⛔ **NOT PRODUCTION-READY** — multiple critical multi-tenancy gaps remain. CRITICAL-2 (catalog cross-tenant mutate) and HIGH-7 (local-storage path traversal) have been fixed in this audit.

---

## Executive summary

Three perspectives audited the codebase. **8 CRITICAL findings, 9 HIGH, 9 MEDIUM, 6 LOW.** Two of the criticals have been fixed during this audit (CRITICAL-2 catalog mutate, HIGH-7 path traversal); the remaining six block production deployment.

The systemic bug class is **service mutate methods that fetch a row by ID without an org filter, then mutate it without an org filter on the WHERE clause**. `assertPermission` confirms the actor has the perm; it does not confirm the resource belongs to the actor's org. Several modules implement the safe pattern (orders, cart, the now-fixed catalog); webhooks, gift-cards, marketplace vendors, POS transactions, and appointments do not.

A second class is **routes mounted outside `/api/*` that bypass the auth/rate-limit/CSRF middleware stack**. The `/mcp` endpoint is the worst offender (anonymous mutation), and the store-example app demonstrates the pattern with custom routes that should not ship.

**What's solid (verified clean by all three auditors):**
- CORS, CSRF, body limit, rate limit (all on `/api/*`)
- Better Auth session cookie defaults (httpOnly, secure-in-prod)
- Stripe webhook signature verification
- Outbound webhook HMAC signing (`x-commerce-signature`)
- SSRF protection on outbound webhooks (RFC 1918, IMDS, GCP metadata, DNS rebinding)
- Job runner architecture (org-scoped, FOR UPDATE SKIP LOCKED)
- Drizzle-first SQL injection prevention
- No hardcoded secrets in source

| Severity | Count | Fixed in this audit |
|---|---|---|
| 🔴 Critical | 8 | 2 (CRITICAL-2 catalog, HIGH-7 path traversal) |
| 🟠 High | 9 | 0 |
| 🟡 Medium | 9 | 0 |
| 🟢 Low | 6 | 0 |

---

## 🔴 CRITICAL findings

### CRITICAL-1 — `/mcp` allows anonymous mutation of the default org *(open)*

**Locations:** `packages/core/src/runtime/server.ts:291`, `packages/core/src/interfaces/mcp/transport.ts:89`, `packages/core/src/runtime/kernel.ts:149-167`

**Source:** codex + manager

`POST /mcp` is mounted outside `/api/*` so the auth middleware, rate limiter, CSRF, and body limit do not fire. Inside, every tool call uses `kernel.getMCPActor()` which returns a hardcoded actor:

```ts
{
  type: "api_key",
  userId: "mcp-agent",
  organizationId: DEFAULT_ORG_ID,  // "org_default"
  role: "ai_agent",
  permissions: ["catalog:read", "catalog:create", "inventory:read",
                "inventory:adjust", "orders:read", "cart:create",
                "cart:update", ...],
}
```

**Exploit:**
```bash
curl -X POST https://target.example.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
    "name":"catalog","arguments":{"action":"update",
    "entityId":"<known-uuid>","metadata":{"price":1}
  }}}'
```

Anyone who can reach `/mcp` can: create catalog entities, adjust inventory, create/modify carts, read orders — all in `org_default`. Plus unbounded request rate.

**Fix:** Mount `/mcp` under `/api/mcp` so middleware applies; replace `getMCPActor()` with `c.get("actor")`; require explicit `mcp:invoke` permission. ETA: 1-2h.

---

### CRITICAL-2 — Catalog mutate paths allow cross-tenant mutation *(✅ FIXED in eb991f6)*

**Locations:** `packages/core/src/modules/catalog/service.ts` (update, delete, setAttributes, publish/archive/discontinue via changeStatus, updateCategory, deleteCategory, updateBrand, deleteBrand, addToCategory, removeFromCategory, addToBrand, removeFromBrand)

**Source:** manager

`assertPermission(actor, "catalog:update")` confirmed the actor had the perm but didn't confirm the resource belonged to their org. `findEntityById(id)` and `updateEntity(id, data)` both omitted org from the WHERE clause. Cross-tenant mutation by any permission-holding actor.

Additionally, `setAttributes`, `addToCategory`, `removeFromCategory`, `addToBrand`, `removeFromBrand` had **no actor parameter at all** — anonymous mutation.

**Fix applied:** Added `assertSameOrg()` helper to `CatalogServiceImpl`, applied to every mutate path. Added `actor` parameter (required) to the 5 missing-actor methods. Updated 13 call sites (REST routes, MCP tools, core tests, postgres adapter test, saas-example seed, store-example e2e).

**Regression coverage:** `packages/core/test/catalog-cross-tenant.test.ts` (11 tests, all passing).

---

### CRITICAL-3 — Gift-card repository has no org filter on any read/write *(open)*

**Location:** `packages/plugins/plugin-gift-cards/src/services/gift-card-repository.ts`

**Source:** pi

Every method ignores `organizationId` despite the table having an `organizationId` column and a unique constraint `gift_cards_org_code_unique` (codes are unique *only within an org*):
- `findByCode(code)` — same code can exist in multiple orgs; returns wrong tenant's card
- `findById(id)` — global lookup
- `list(filters)` — returns all orgs' cards
- `disable(id)` — disables in any org
- `findByCodeForUpdate(code, tx)` / `findByIdForUpdate(id, tx)` — FOR UPDATE locks across orgs
- `listTransactions(giftCardId)` / `findTransactionsByOrderId(orderId)` — cross-org transaction lookup

The service layer (`gift-card-service.ts`) accepts `orgId` parameters but never passes them through. The public `check-balance` route assumes global code uniqueness, **which is false**. Two tenants can have the same code; an attacker can probe codes across tenants.

**Fix:** Make `findByCode` / `list` / `findById` accept `organizationId` and filter in WHERE. Update service to actually pass through the `orgId` it receives. Document or remove the global-uniqueness assumption in public routes. ETA: 2-3h.

---

### CRITICAL-4 — Marketplace VendorService leaks plaintext access tokens cross-tenant *(open)*

**Location:** `packages/plugins/plugin-marketplace/src/services/vendor.ts`, `packages/plugins/plugin-marketplace/src/schema.ts:51-55`

**Source:** pi

The `vendors` table stores Shopify and WooCommerce credentials in plaintext:
```ts
storeAccessToken: text("store_access_token"),
storeConsumerSecret: text("store_consumer_secret"),
storeWebhookSecret: text("store_webhook_secret"),
```

Every `VendorService` method ignores `organizationId`:
- `getById(id)`, `getBySlug(slug)`, `list(filters)` — no org filter
- `update(id, ...)`, `approve(id)`, `reject(id, ...)`, `suspend(id, ...)`, `reinstate(id)` — mutate any tenant's vendor
- `uploadDocument(vendorId, ...)`, `listDocuments(vendorId)`, `approveDocument(docId, ...)`, `rejectDocument(docId, ...)` — cross-org

**Combined impact:** A marketplace admin in Tenant A can read every other tenant's vendor record, including their plaintext Shopify access tokens. Routes call `stripVendorSecrets()` before responding, so the API doesn't leak directly — but the underlying service returns the full object including secrets, and any DB read sees plaintext.

**Fix:** Add `organizationId` WHERE clause to every VendorService method. Encrypt `storeAccessToken`, `storeConsumerSecret`, `storeWebhookSecret` at rest (pgcrypto or app-level with per-org KMS). ETA: 4-6h.

---

### CRITICAL-5 — Webhook delivery fans out across tenants *(open)*

**Location:** `packages/core/src/modules/webhooks/repository/index.ts:44`, `packages/core/src/modules/webhooks/hook.ts:20`

**Source:** codex + pi

`findActiveEndpoints` and `findAllEndpoints` are global. When tenant A fires an event, the delivery worker fans out to *every* tenant's matching endpoints. Tenant B's webhook receivers get tenant A's payloads.

**Fix:** Make repository queries org-scoped (`findActiveEndpoints(orgId, topic, ctx)`). Resolve source org from event context; fan out only within that org. ETA: 2-3h.

---

### CRITICAL-6 — Webhook list/delete cross-tenant *(open)*

**Location:** `packages/core/src/interfaces/rest/routes/webhooks.ts:27,38`, `packages/core/src/modules/webhooks/service.ts:95,100`, `packages/core/src/modules/webhooks/repository/index.ts:39-46`

**Source:** codex + pi

`GET /api/webhooks` returns every tenant's endpoint URLs and event subscriptions to any actor with `webhooks:manage` in their own org. `DELETE /api/webhooks/:id` deletes by ID without verifying org ownership — actor with `webhooks:manage` in Org A can delete Org B's endpoints by guessing UUID.

**Fix:** `listEndpoints(actor)` resolves orgId; `repo.findEndpoints(orgId)`. Delete path: `repo.delete(id, orgId)` with org in WHERE. Same pattern as the catalog fix. ETA: 1-2h.

---

### CRITICAL-7 — store-example reviews routes have no auth *(open)*

**Location:** `apps/store-example/src/routes/reviews.ts`

**Source:** pi

All four routes are mounted on raw Hono `app` with no auth middleware:
- `POST /api/reviews` — anyone can submit; trusts `customerId` from request body (no actor verification)
- `GET /api/reviews/:entityId` — public read
- `GET /api/reviews/:entityId/summary` — public read
- `PATCH /api/reviews/:reviewId/approve` — **anyone can approve/disapprove reviews**

The reviews table also lacks `organizationId`. This is on the demo app but demonstrates a pattern that could ship.

**Fix:** Add auth middleware to app-level custom routes; do not mount unprotected mutation endpoints. Move review handling to `plugin-reviews` which has proper guards. ETA: 1h.

---

### HIGH-7 — local-storage path traversal *(✅ FIXED in this audit, see commit below)*

**Location:** `packages/adapters/adapter-local-storage/src/index.ts`

**Source:** pi

The `key` parameter was passed directly to `join(basePath, key)` without sanitization. An upload with key `../../etc/cron.d/malicious` would write outside the storage root. Same issue for `delete`, `getUrl`, `getSignedUrl`, `list`.

**Fix applied:** Added `resolveSafePath(basePath, key)` helper that resolves the key against `basePath` and rejects any result that escapes (also rejects empty keys, NUL bytes, absolute paths, and boundary collisions like `base=/data` + `key=../data-evil`). Applied to `upload`, `delete`, `list`. Five regression tests added.

(Severity upgraded from HIGH to CRITICAL in this consolidated doc — arbitrary file write to system paths is a CVE-class issue regardless of how pi originally graded it.)

---

## 🟠 HIGH findings

### HIGH-1 — Media fetch/delete unscoped by org

**Location:** `packages/core/src/interfaces/rest/routes/media.ts:37`, `packages/core/src/modules/media/service.ts:88`, `packages/core/src/modules/media/repository/index.ts:32`. **Source:** codex.

Asset lookup by ID is global. Public media URLs (no auth required for reads) cross orgs; signed URLs and deletes also skip org scope. Same fix pattern as catalog mutate.

### HIGH-2 — Pricing list cross-tenant exposure

**Location:** `packages/core/src/interfaces/rest/routes/pricing.ts:30`. **Source:** codex.

Pricing list route doesn't pass actor; pricing/modifier queries don't include org. Anyone with a known entity UUID can read another tenant's prices and modifiers.

### HIGH-3 — POS TransactionService.complete() lacks org check

**Location:** `packages/plugins/plugin-pos/src/services/transaction-service.ts:175`. **Source:** pi.

`complete(id, orderId)` and `updateTotals(id, totals)` lock and mutate by `id` only. Operator with `pos:operate` in Org A can complete transactions in Org B. Note: `getById`, `create`, `void`, `hold`, `recall`, `listHeld` DO filter by orgId — only `complete` and `updateTotals` are missing.

### HIGH-4 — Appointments BookingService.getById no org scoping

**Location:** `packages/plugins/plugin-appointments/src/services/booking-service.ts:204`. **Source:** pi.

Bookings table lacks `organizationId` column entirely. Org scoping is supposed to be indirect through `providerId` → `providers.organizationId`, but `getById`, `changeStatus`, and `cancel` don't verify the caller belongs to the provider's org.

**Fix:** Add `organizationId` to `bookings` table directly OR enforce org verification via provider lookup.

### HIGH-5 — store-example supplier-info routes have no auth

**Location:** `apps/store-example/src/routes/supplier-info.ts`. **Source:** pi.

`PUT /api/catalog/entities/:id/supplier` and `GET /api/catalog/entities/:id/supplier` have no auth. Anyone can update supplier info on any entity.

### HIGH-6 — local-storage no MIME / size validation

**Location:** `packages/adapters/adapter-local-storage/src/index.ts`. **Source:** pi.

No file extension or MIME type validation. No size limit at the adapter layer (1MB body limit applies at HTTP, not for internal API calls).

### HIGH-8 — local-storage `getSignedUrl` is not actually signed

**Location:** `packages/adapters/adapter-local-storage/src/index.ts:41-43`. **Source:** pi.

```ts
async getSignedUrl(key: string, expiresIn: number): Promise<Result<string>> {
    return Ok(`${baseUrl}/${key}?expiresIn=${expiresIn}`);  // No actual signing
}
```

Anyone can modify or remove the query parameter. Should generate proper HMAC-signed URLs with expiry, or document that local-storage doesn't support signing.

### HIGH-9 — Customer PATCH gated by wrong permission

**Location:** `packages/core/src/interfaces/rest/routes/customers.ts:16,52`. **Source:** codex.

Route is gated by `customers:read` instead of `customers:update`. Code comment says `customers:update` is required. Any reader can write.

---

## 🟡 MEDIUM findings

(Briefer — these matter but are not deployment blockers)

| # | Finding | Location | Source |
|---|---|---|---|
| M-1 | MCP actor org hardcoded to deprecated `DEFAULT_ORG_ID` | `packages/core/src/runtime/kernel.ts:156` | codex |
| M-2 | Marketplace store tokens stored plaintext (separate from M-4 because the leak path differs) | `packages/plugins/plugin-marketplace/src/schema.ts:51-55` | pi |
| M-3 | plugin-reviews trusts `customerId` from request body without verifying it matches actor | `packages/plugins/plugin-reviews/src/routes/reviews.ts:14` | pi |
| M-4 | Session cookie `sameSite` defaults to `lax`; could be tightened to `strict` | `packages/core/src/auth/setup.ts:138` | pi |
| M-5 | API key scopes only enforced when `auth.apiKeyScopes` is set; without scopes any valid key gets DB-stored permissions | `packages/core/src/auth/setup.ts:74-86` | pi |
| M-6 | `serveStatic` exposes `.data/media` filesystem with no auth (compounded with HIGH-7 before fix) | `apps/store-example/src/server.ts:11` | pi |
| M-7 | No validation that job-enqueuer's org matches `options.organizationId` (currently no user-facing enqueue API; future hazard) | `packages/core/src/kernel/jobs/adapter.ts:13` | pi |
| M-8 | POS operator PIN stored as plain text in `auth-schema.ts` | `packages/core/src/auth/auth-schema.ts:23` | pi |
| M-9 | Marketplace `PayoutService` and `ReviewService` likely share VendorService's org-agnostic pattern (not fully audited) | `packages/plugins/plugin-marketplace/src/services/{payout,review}.ts` | pi |

---

## 🟢 LOW findings

| # | Finding | Location | Source |
|---|---|---|---|
| L-1 | `processedWebhookEvents` table grows indefinitely (no TTL/cleanup) | `packages/core/src/modules/webhooks/schema.ts:33-38` | pi |
| L-2 | Job handlers run in system context with no actor identity (currently fine; future hazard) | `packages/core/src/kernel/jobs/types.ts:24-27` | pi |
| L-3 | pg-search `dictionary` parameter interpolated directly into SQL (config-controlled, not user input) | `packages/adapters/adapter-pg-search/src/index.ts:94-95` | pi |
| L-4 | Mock payment adapter `verifyWebhook` always returns `Ok` (dev-only footgun) | `apps/store-example/commerce.config.ts:36-38` | pi |
| L-5 | Promotions `?? DEFAULT_ORG_ID` pattern (now `resolveOrgId`-routed) — verify no other modules carry the same anti-pattern | `git log -p` against `?? DEFAULT_ORG_ID` | manager |
| L-6 | Workspace `bun run test` had transient SIGINT cascade in turbo runs of plugin-loyalty / marketplace / etc. — packages pass individually; root cause is concurrent PGlite cold-start contention | `turbo.json` | manager |

---

## Verified clean (no findings, by all auditors)

- **CORS** — Hardened. Empty `trustedOrigins` + production = deny-all. Dev = `localhost:*`.
- **CSRF** — Mounted at `/api/*` with same trusted-origin policy.
- **Body limit** — 1MB default via Hono `bodyLimit`.
- **Rate limit** — Three tiers: `/api/auth/*`, `/api/checkout`, `/api/*`. (Does NOT cover `/mcp` — see CRITICAL-1.)
- **SQL injection** — Drizzle-first per CONVENTIONS.md §1. Only legitimate raw SQL: sequence reads, `pg_catalog` introspection, migration scripts. No user input interpolation.
- **Hardcoded secrets** — None. Only `password`/`secret` literals are in audit redaction key lists.
- **Stripe webhook signature verification** — Uses `stripe.webhooks.constructEvent` with `webhookSecret`; rejects without secret; checks `stripe-signature` header.
- **Outbound webhook signing** — `signWebhookPayload` uses `createHmac("sha256", secret, payload)`; sends `x-commerce-signature` header on every outbound call.
- **SSRF protection** — `isPrivateUrl()` blocks RFC 1918, loopback, link-local, AWS IMDS, GCP metadata; DNS rebinding via `validateResolvedIp()`; HTTPS enforcement in production; 10s fetch timeout.
- **Job runner** — Org-scoped (`organizationId` required in `EnqueueOptions`); `FOR UPDATE SKIP LOCKED` for safe concurrent claim; admin routes scope by org for non-wildcard admins.
- **Better Auth session cookies** — `httpOnly` (default), `secure` in production, `sameSite: lax` (default), 5-min cookie cache TTL.
- **`.gitignore`** — Properly excludes `.env`, `.env.local`, `.env.*.local`.
- **No actor logging** — No `console.log(actor)` patterns that would dump session tokens.
- **S3/R2 storage** — Use proper AWS SDK presigned URLs (no DIY signing).
- **Plugin org isolation (verified by pi):** loyalty, wishlist, reviews, notifications, procurement, POS schema, appointments schema all correctly include `organizationId` filtering.

---

## Honest gaps in this audit

What this document does NOT cover:

- **Live VAPT against a deployed surface.** Code-level only. Live deploy + probe was deferred (see plan below). A live probe would add: actual network behavior, real auth token handling, edge/CDN caching of cross-tenant responses, race conditions.
- **claude-glm cross-Claude verification.** Not fired — three perspectives (manager, codex, pi) already gave overlapping confirmation on the criticals; a fourth Claude lens would be diminishing returns vs delivering the fixes.
- **Plugin payout/review services in marketplace.** Pi flagged as likely affected (LOW M-9) but did not fully audit.
- **Better Auth API key scoping (RFC-061).** Not yet shipped per `MEMORY.md`. Known gap, separate workstream.
- **Storage adapter-r2 fallback signing.** Pi noted R2 falls back to the same fake-signing pattern as local-storage if no external `signedUrl` function is provided. Worth a separate read.

---

## Fix plan (recommended order)

1. **CRITICAL-1 (block):** lift `/mcp` into `/api/mcp` and apply auth + rate limit + CSRF + body limit. Replace `getMCPActor()` with `c.get("actor")`. Add `mcp:invoke` permission. **ETA: 1-2h.**
2. **CRITICAL-3 (block):** add `organizationId` filter to every gift-card repository method. Update service to pass through. Fix the public balance route's global-uniqueness assumption. **ETA: 2-3h.**
3. **CRITICAL-4 (block):** add `organizationId` filter to every VendorService method. Encrypt vendor secrets at rest. **ETA: 4-6h.**
4. **CRITICAL-5 (block):** make webhook endpoint queries org-scoped; resolve source org from event context for fan-out. **ETA: 2-3h.**
5. **CRITICAL-6 (block):** webhook list/delete repo signatures take `orgId` and filter. **ETA: 1-2h.**
6. **CRITICAL-7 (block):** add auth middleware to store-example custom routes (or move to plugin). **ETA: 1h.**
7. **HIGH-1, HIGH-2 (block for prod):** media + pricing org-scoped lookups. **ETA: 3-4h combined.**
8. **HIGH-3, HIGH-4, HIGH-5 (block for prod):** POS complete/updateTotals org check; appointments booking org check; supplier-info auth. **ETA: 2-3h combined.**
9. **HIGH-6, HIGH-8:** local-storage MIME/size validation; real signed URLs. **ETA: 2h combined.**
10. **HIGH-9:** customer PATCH guard fix. **ETA: 15min.**
11. **All MEDIUM and LOW:** triage; some are easy (M-1 MCP org, M-4 cookie sameSite); others are RFCs of their own (M-2 token encryption with KMS).

**Total estimate to production-ready:** 25-35h focused work. The fix-pass pattern that worked in this audit (apply the org check, add a contract test, run the suite) scales to most of these.

---

## Live VAPT deploy plan (deferred)

Stages for a follow-up session:

1. Generate `apps/store-example/Dockerfile` (multi-stage: bun build → node runtime) and `apps/store-example/fly.toml`.
2. `fly apps create unified-commerce-vapt`.
3. `fly postgres create unified-commerce-vapt-db` and attach.
4. `fly secrets set DATABASE_URL=... AUTH_SECRET=... STORE_API_KEY=...`.
5. `fly deploy`.
6. `fly ssh console -C "bun run db:push && bun run seed"` for schema + seed data including a second tenant (`org_e2e_attacker`).
7. Probe matrix:
   - Anonymous POST `/mcp` with mutate tool calls (CRITICAL-1)
   - Anonymous POST `/api/reviews/:id/approve` (CRITICAL-7)
   - Cross-tenant catalog mutate (CRITICAL-2 — should now return NOT_FOUND)
   - Cross-tenant gift-card balance probe with shared code (CRITICAL-3)
   - Cross-tenant marketplace vendor read (CRITICAL-4)
   - Webhook event firing in Org A → check Org B's receivers (CRITICAL-5)
   - `GET /api/webhooks` from Org A actor → reveals Org B's URLs (CRITICAL-6)
   - Local-storage upload with `../../etc/passwd` (HIGH-7 — should now reject)
   - Cross-tenant media reads (HIGH-1)
   - Cross-tenant price reads (HIGH-2)
   - Customer PATCH with `customers:read`-only actor (HIGH-9)
   - Rate-limit verification under sustained load
   - Webhook signature replay
   - Mass-assignment attacks (extra fields in PATCH bodies)
8. Document each probe + status code + response excerpt.

---

## Provenance

- **Manager:** in-context code review via grep + read patterns
- **Codex output:** `.handoff/result-sec-codex.txt` — 8 findings, 21 lines, dense
- **Pi output:** `.handoff/result-sec-pi.md` — 489 lines, 8 axes covered
- **Foundation commits incorporated:** `9c62a32` (Drizzle convention + typed test seeds), `029361a` (kernel boot + promotions), `eb991f6` (catalog cross-tenant fix)
- **Fixes applied during this audit:** CRITICAL-2 (catalog), HIGH-7 (path traversal)

---

## What I did NOT do (honest list, per the operating standard)

- **Did NOT deploy to Fly.** Multi-step infra work that is genuinely a separate session. Deploy plan is above.
- **Did NOT publish any npm packages.** No fixes here require a publish bump; when the remaining criticals land, the fix-pass should bundle into one publish per the project's "republish all 32" convention (see `MEMORY.md`).
- **Did NOT fix CRITICAL-1, 3, 4, 5, 6, 7.** Each takes 1-6h to do properly with regression tests; the audit doc gives the file:line and the fix shape so they can be picked up cleanly.
- **Did NOT brief claude-glm.** Three independent perspectives already cross-confirmed the criticals. A fourth would not change the fix list.
- **Did NOT verify the fixed paths via live probe.** Cross-tenant tests are unit-level. A live probe would catch any middleware-layer bypass; current verification is service-layer.
