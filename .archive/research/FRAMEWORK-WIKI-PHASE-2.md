# Framework Research Wiki — Phase 2: The Non-Obvious

> Companion to `FRAMEWORK-WIKI.md`. Phase 1 covered the obvious technical debt and extraction blueprint. Phase 2 covers what only surfaces under stress: live bugs, security holes, dead infrastructure, operational reality, strategic position, and DX papercuts.
>
> **TL;DR:** Phase 1 said "extract internally now, publish externally when a second app emerges." Phase 2 says **the public-extraction timeline is much further away than Phase 1 suggested**. There are live bugs in production code, three critical multi-tenancy hazards, a missing LICENSE file, dead infrastructure documented as features, and a starter template that doesn't run. Fix the foundation before talking about a framework.

---

## Table of Contents

1. [The Picture That Changed](#1-the-picture-that-changed)
2. [Live Bugs (Not Theoretical)](#2-live-bugs-not-theoretical)
3. [Critical Multi-Tenancy Hazards](#3-critical-multi-tenancy-hazards)
4. [Dead Infrastructure: Documented Features That Don't Exist](#4-dead-infrastructure-documented-features-that-dont-exist)
5. [Coupling Reality (Hono / Drizzle / Better Auth)](#5-coupling-reality-hono--drizzle--better-auth)
6. [Operational Reality and the 3 AM Test](#6-operational-reality-and-the-3-am-test)
7. [Strategic Position and Market Reality](#7-strategic-position-and-market-reality)
8. [DX Papercuts That Block External Adoption](#8-dx-papercuts-that-block-external-adoption)
9. [The Updated Recommendation](#9-the-updated-recommendation)
10. [The Pre-Extraction Punch List](#10-the-pre-extraction-punch-list)

---

## 1. The Picture That Changed

Phase 1 found a clean architectural foundation with three concentrated debt files. That assessment was correct as far as it went. But it missed:

| Category | Phase 1 said | Phase 2 found |
|----------|--------------|---------------|
| Webhook delivery | "Async via job queue, well-designed" | **Webhooks are broken for catalog, cart, customers, pricing, promotions, fulfillment** — they fire as `unknown.create`/`unknown.update` because only orders and inventory set `moduleName`. Live bug. |
| `LocalAPI` for plugins | "Elegant proxy, default promoted path" | **`commerce.api.giftCards.checkBalance()` is JSDoc-documented but doesn't work.** Plugins never register into `kernel.services`. Fictional API. |
| Hook context | "Generic, framework-level, well-typed" | **`HookContext.db` is `null` for every module except `orders`.** Typed as `PluginDb`, silently null in practice. Plugin authors crash at runtime. |
| Multi-tenancy | "Built-in, organization scoping" | **3 critical isolation hazards** — `storeResolver` failure silently routes to `org_default` (cross-tenant data leak), `inventory_levels`/`inventory_movements` lack `organization_id` columns, plugins have raw DB access bypassing all scoping. |
| Inventory operations | "Atomic CAS, optimistic locking" | **`inventory.adjust()` is NOT concurrency-safe.** Read-modify-write without row lock. The `version` column exists for OCC but isn't used in the `WHERE` clause. Lost-update bug under any concurrency. |
| Compensation chain | "Well-designed saga pattern" | **Compensation failures persist nowhere.** Customer charged + order cancelled with audit-log gap. Lives only in stdout logs. |
| Hono / Drizzle agnosticism | "Adapter pattern, swappable" | **47 files import Hono. 39 files import Drizzle. The "generic `DatabaseAdapter`" is theatrical — every plugin is locked to Hono+Drizzle+PG.** |
| Starter & onboarding | "Examples exist" | **The starter template uses `sqlite` (unsupported), ships no `drizzle.config.ts`, and won't boot.** No `bunx create-unified-commerce` exists. |
| LICENSE | (not addressed) | **No LICENSE file at repo root or in `packages/core/package.json`.** Un-licensed code is "all rights reserved" by default. Day-one issue. |
| Strategic position | "Extract when a second app emerges" | **PayloadCMS was acquired by Figma (June 2025) — the "PayloadCMS-pattern but generic" position is genuinely vacant. But: bus factor of 1, no public production customers, framework+flagship pattern requires team or funding.** |

Phase 2's verdict isn't "kill the project." It's "the foundation needs more work than Phase 1 acknowledged before any framework conversation is honest."

---

## 2. Live Bugs (Not Theoretical)

These are not architectural debt items. They are bugs that exist in production code right now.

### LB-1: Webhook delivery is broken for 6 of 8 wired modules
**Severity:** HIGH | **File:** `modules/webhooks/hook.ts:14`

```typescript
const eventName = `${context.context.moduleName ?? "unknown"}.${operation}`;
```

Only `OrderService` (`orders/service.ts:108`) and `InventoryService` (`inventory/service.ts:364`) set `context.context.moduleName`. The kernel wires `deliverWebhooks` to the after-hooks of:

- `orders.afterCreate` ✅ works
- `orders.afterStatusChange` ✅ works
- `inventory.afterAdjust` ✅ works
- `catalog.afterCreate` ❌ fires as `unknown.create`
- `catalog.afterUpdate` ❌ fires as `unknown.update`
- `catalog.afterDelete` ❌ fires as `unknown.delete`
- `customers.afterCreate` ❌ fires as `unknown.create`
- `customers.afterUpdate` ❌ fires as `unknown.update`
- `pricing.afterCreate` ❌
- `pricing.afterUpdate` ❌
- `promotions.afterCreate` ❌
- `promotions.afterUpdate` ❌
- `fulfillment.afterCreate` ❌
- `cart.afterAddItem` ❌

**Impact:** Any subscriber filtering by event name (which is the documented usage pattern) misses every catalog/customer/pricing/promotions/fulfillment/cart event. They're delivered but invisible.

**Fix:** Each service must set `context.context.moduleName` in `runAfterHooks`. ~14 lines across 6 service files.

---

### LB-2: `commerce.api.giftCards.checkBalance(...)` is fictional
**Severity:** MEDIUM | **File:** `kernel/local-api.ts:24`

The Local API JSDoc documents:

```typescript
// commerce.api.giftCards.checkBalance("CARD-CODE")
// commerce.api.loyalty.redeemPoints({...})
```

The Proxy delegates to `kernel.services` (line 103). But `kernel.services` is a **closed shape** typed at compile time. Plugins instantiate their services freshly inside `routes(ctx)` and `mcpTools(ctx)` — they never call any `register("giftCards", svc)` mechanism because that mechanism doesn't exist.

Result: `commerce.api.giftCards` is `undefined`. The documented headless plugin API is fiction.

**Fix:** Either implement plugin service registration (`config.services` slot in the manifest), or remove the JSDoc claim.

---

### LB-3: `HookContext.db` is `null` for every module except orders
**Severity:** HIGH | **File:** `kernel/hooks/create-context.ts:39`, `kernel/hooks/types.ts:38`

```typescript
// types.ts
export interface HookContext {
  db: PluginDb;  // typed non-null
  ...
}

// create-context.ts
db: (args.db ?? args.kernel?.database?.db ?? null) as PluginDb;
```

The cast hides a `null`. Only `OrderService` passes `kernel` to `createHookContext` (`orders/service.ts:81-101`). Catalog, cart, inventory, customers, pricing, promotions, fulfillment, media — none of them pass `kernel`. So plugin hooks attached to those modules' events receive `ctx.db === null` despite the type system claiming otherwise.

**Impact:** A plugin author writing `await ctx.db.insert(...)` inside a `catalog.afterCreate` hook will get `Cannot read properties of null` at runtime. The type system actively hides this.

**Fix:** Either thread `kernel` through every service constructor, or type `db` as `PluginDb | null` and force handlers to check.

---

### LB-4: `inventory.adjust()` is not concurrency-safe
**Severity:** CRITICAL | **File:** `modules/inventory/service.ts:289-377`, `modules/inventory/repository/index.ts:225-237`

`adjust()` does:
```
findLevelByKey(...) → updateLevel(id, { quantityOnHand: existing + adjustment })
```

This is read-modify-write without a row lock. Two concurrent `adjust(+5)` calls both read `quantityOnHand=10`, both write `15` — final value is `15` instead of `20`. **Lost update.**

The `inventory_levels` table has a `version` column suggesting an OCC pattern was intended — but `updateLevel` does not check `version` in the `WHERE` clause. The CAS is incomplete.

**Impact:** Under any concurrent inventory operations, stock is silently miscounted. The `inventory_movements` audit trail won't show the race because only one of the two writes "won."

**Fix:** Use `SELECT ... FOR UPDATE` (which `reserveWithLock` already uses) or implement real OCC with `WHERE id = ? AND version = ?` plus retry loop.

---

### LB-5: Webhook double-retry (in-process × job-level)
**Severity:** HIGH | **Files:** `modules/webhooks/worker.ts:90`, `modules/webhooks/tasks.ts:48-52`

The worker has an inner `while (attempt < maxAttempts)` loop with `maxAttempts = 3`, no `await sleep()` between attempts. The job framework wraps this with `attempts: 5`. Result: a failing endpoint is hit `3 × 5 = 15` times across attempts, the inner three back-to-back in milliseconds.

**Impact:** Receivers see 15 rapid duplicate deliveries. No idempotency key in the payload to help them dedupe.

**Fix:** Pick one retry strategy. Either rip out the inner loop or rip out `maxAttempts: 5` at the job level.

---

### LB-6: `process.exit(1)` breaks Cloudflare Workers
**Severity:** HIGH | **File:** `runtime/server.ts:74-82`

```typescript
process.on("unhandledRejection", () => process.exit(1));
process.on("uncaughtException", () => process.exit(1));
```

The README claims Cloudflare Workers support. In CF Workers, `process.exit` is undefined and calling it throws. The serverless-first claim is contradicted by code that assumes a long-running process.

**Fix:** Conditional installation — skip the handlers when `typeof process.exit !== "function"` or when running in an edge runtime.

---

### LB-7: Order number generation is not concurrent-safe
**Severity:** HIGH | **File:** `modules/orders/repository/index.ts`

`getNextOrderNumber()` does `SELECT COUNT(*) FROM orders WHERE YEAR = :year` then computes `count + 1`. Two concurrent inserts read the same count and generate **duplicate order numbers**.

**Fix:** Replace with PostgreSQL sequence (`CREATE SEQUENCE order_number_seq` + `nextval()`). One-day fix.

---

### LB-8: URL alias re-dispatch double-counts rate limits
**Severity:** HIGH | **File:** `runtime/server.ts:261-287`

Every `/api/products` request clones itself into a new `Request` and calls `app.fetch()` against `/api/catalog/entities?type=product`. This re-enters CORS, CSRF, body-limit, **all three rate limiters**, auth middleware, and the error handler.

**Impact:** A client hitting alias endpoints burns through their rate quota at 2× the configured rate. Premature rate-limiting under normal load.

**Fix:** Inject `type` into Hono context directly without re-dispatching.

---

## 3. Critical Multi-Tenancy Hazards

These are textbook tenant isolation breaches. Any of them in production is a data-leak incident.

### MT-1: `storeResolver` failure silently routes to `org_default`
**Severity:** CRITICAL | **File:** `auth/middleware.ts:179-204`

```typescript
if (config.auth?.storeResolver) {
  try {
    const resolved = await config.auth.storeResolver(c.req.raw);
    if (resolved) { ... }
  } catch {
    // fall through — no actor
  }
}
```

The empty `catch` is the entire problem. In a multi-store SaaS where each storefront is its own org, if `storeResolver` throws (DNS hiccup, throttling, DB lookup failure), the request silently assigns to `defaultOrgId`. Shopper for `tenantA.example.com` could see `org_default`'s data.

**Fix:** Fail closed. If `storeResolver` is configured and fails, the request must be rejected with 503, not silently routed to the default org.

---

### MT-2: `resolveOrgId(null)` is a footgun
**Severity:** HIGH | **File:** `auth/org.ts:34-42`

The fallback chain: `actor.organizationId` → `defaultOrgId` param → `_bootDefaultOrgId` → literal string `"org_default"`. Three levels of fallback. **No "fail closed" mode exists.**

A null actor in any service silently writes to the default org. The audit hook is the canonical example: `audit/service.ts:97` calls `resolveOrgId(ctx.actor)` and a system-actor or anonymous-actor write silently stamps `org_default`.

**Fix:** Add `STRICT_ORG_RESOLUTION` env var that turns the fallback into a thrown error. Force operators to opt out of strict mode for backwards compatibility.

---

### MT-3: `inventory_levels` and `inventory_movements` lack `organization_id`
**Severity:** HIGH | **File:** `modules/inventory/schema.ts:35-94`

These tables have **no `organization_id` column**. Cross-org isolation depends entirely on the `warehouseId → warehouse.organizationId` join chain.

A plugin or hook that creates an `inventory_levels` row pointing at a warehouse from a different org is not rejected at the DB level. There's no row-level security, no schema-level pgPolicy. Defense depends on plugin author discipline.

**Fix:** Add `organization_id` columns with `NOT NULL` constraints and CHECK constraint that they match the warehouse's org.

---

### MT-4: Plugins have raw DB access bypassing all scoping
**Severity:** HIGH | **File:** `runtime/kernel.ts:226`, `kernel/plugin/manifest.ts:46`

```typescript
serviceContainer.database = database;
// ...
PluginContext.database.db: PluginDb  // raw Drizzle handle
```

Any plugin that runs `db.select().from(orders)` without `WHERE organizationId = ?` reads across tenants. The `createScopedDb()` proxy exists but is only injected through the `router()` builder — never on `PluginContext.database`. Tenant isolation depends entirely on plugin author discipline.

**Fix:** Make `PluginContext.database.db` the scoped proxy by default. Provide `database.unscoped` as the explicit escape hatch.

---

### MT-5: `DrizzleJobsAdapter.enqueue()` silently defaults to `org_default`
**Severity:** HIGH | **File:** `kernel/jobs/drizzle-adapter.ts:44`

```typescript
organizationId: options?.organizationId ?? DEFAULT_ORG_ID
```

A plugin enqueuing a job from inside an org-scoped operation must remember to pass `organizationId`. Forget once and the job is filed under the default org. The job runner runs handlers with `services` that are unscoped — handlers must re-resolve the org from job input. Nothing enforces this.

**Fix:** `enqueue()` must require `organizationId` (no default), OR read it from an ambient actor context. Currently both fail.

---

### MT-6: Audit hooks can't catch their own org-leak
The audit hook fires after the operation. If the operation wrote to the wrong org (because of MT-1 through MT-5 above), the audit row is ALSO written to the wrong org, perfectly disguising the breach. Audit cannot detect tenant leaks because audit is itself subject to the same fallback chain.

**Fix:** Audit must always include the *requested* org and the *actor's claimed* org as separate fields, so a mismatch is queryable.

---

## 4. Dead Infrastructure: Documented Features That Don't Exist

These are features the codebase claims via JSDoc, READMEs, or type definitions — but the wiring doesn't exist.

| Feature | Documented at | Actually wired? |
|---------|---------------|-----------------|
| `extraColumns` for plugin column extension | `kernel/schema/extra-columns.ts` | ❌ `mergeExtraColumns` exported, **called nowhere in core or plugins**. Dead infrastructure. |
| `PaymentAdapter.extraColumns()` | `payments/adapter.ts:46` | ❌ Defined in interface, never invoked. |
| `manifest.permissions` | `kernel/plugin/manifest.ts:78` JSDoc claims "validated at boot, available via `GET /api/admin/permissions`" | ❌ Field is collected and never published. The `/api/admin/permissions` route doesn't exist. The validation against `.permission()` calls doesn't exist. |
| `commerce.api.giftCards.*` | `kernel/local-api.ts:24-27` JSDoc | ❌ Plugin services never register into `kernel.services`. (LB-2) |
| `buildSchema()` for production | `kernel/database/migrate.ts:38` | ⚠️ Only called in `createPluginTestApp`. Production deployments must wire `customSchemas` manually in their own `drizzle.config.ts`. No helper emits the right list. |
| Catalog `beforeRead`/`afterRead`/`beforeList`/`afterList` hooks | `config/types.ts:40-43` | ❌ Type declares 10 events; only ~4 are actually invoked by the catalog service. |
| `customerPermissions` config field | `config/types.ts` | ⚠️ Hardcoded **twice** in `auth/middleware.ts:14-24` and `auth/middleware.ts:193-198`. Drift hazard. |
| `bunx create-unified-commerce` | README "Option 1: Install from npm" | ❌ "Note: Packages are not yet published to npm. Use Option 2 for now." Phantom command. |
| Hook key validation | (implicit) | ❌ No warn-on-unknown-key, no enum, no introspection. Misspelled keys silently no-op. |
| Plugin schema collision detection | (claimed in JSDoc on `manifest.schema`) | ⚠️ Detects export-name collisions in test only; SQL-level table name collisions only surface at `drizzle-kit push` with a confusing DDL error. |

**Impact:** A plugin author reading docs and writing against these promises will hit silent failure. There's no "this feature isn't implemented" warning.

**Fix:** Remove the docstrings for unwired features, or implement them. Keep the type system honest.

---

## 5. Coupling Reality (Hono / Drizzle / Better Auth)

The Phase 1 wiki said the framework had "agnostic adapter interfaces." Phase 2 audited the actual coupling.

### Hono — coupled, not agnostic
- **47 files** in `packages/core/src` import from `hono` or `@hono/zod-openapi`.
- `CommerceConfig.routes: (app: Hono<any>, kernel: Kernel) => void` — Hono in the public type.
- `CommerceConfig.middleware?: MiddlewareHandler[]` — Hono type.
- `mapErrorToStatus` returns `ContentfulStatusCode` from `hono/utils/http-status`.
- Plugin route registration union references `RouteConfig` from `@hono/zod-openapi`.
- The `router()` builder wraps `createRoute()` — every plugin using the recommended pattern is pinned to Hono+Zod.

**Verdict:** Hono has won. Migration to Fastify/Express/Elysia would require rewriting every plugin.

### Drizzle — coupled, not agnostic
- **39 files** import `drizzle-orm` or `drizzle-orm/pg-core`.
- `PluginContext.database.db: PluginDb = PgDatabase<...>` — every plugin gets a Drizzle PG handle.
- `buildSchema()` knows only about Drizzle `pgTable` objects.
- `extraColumns` types its argument as `PgColumnBuilderBase` from `drizzle-orm/pg-core`.
- `auth-schema.ts` is generated by `@better-auth/cli` against Drizzle.

**Verdict:** Drizzle on Postgres is the only supported stack. The "DatabaseAdapter is generic" claim is theatrical.

### Better Auth — coupled, multi-tenancy is bundled
- `Actor.vendorId` is set from a **custom Better Auth additional field** required by the marketplace plugin. Better Auth's user table schema is being amended to support a plugin's domain concept.
- Multi-tenancy *is* the Better Auth `organization` plugin. Every `organizationId` reference in core schemas points at the `organization` table from `auth-schema.ts`.
- If a user replaces Better Auth, they lose the `organization` table — and every core table has a foreign key to it.

**Verdict:** Swapping auth providers is impossible without a fork of the entire schema layer.

### Implication for the framework story

Phase 1 said *"the framework is agnostic, adapters are seams."* Phase 2 says: **the framework is opinionated about Hono+Drizzle+Better Auth. That opinion is not wrong** — it's the right choice for the target use case — but the marketing should not pretend otherwise. Call it what it is: "the Hono+Drizzle+BetterAuth+MCP framework," not "an agnostic kernel."

---

## 6. Operational Reality and the 3 AM Test

### Compensation failure has no remediation persistence (CRITICAL)
**File:** `kernel/compensation/executor.ts:46-51`, `hooks/checkout-completion.ts:161-168`

When compensation fires (e.g., capture step fails → release inventory) and `inventory.release` itself throws, the executor catches `compensateError`, **logs it to stdout, and continues**. The original error is returned. No dead-letter queue. No compensation retry. No operator-facing alert. No persisted "needs manual review" flag.

**The order is marked `cancelled` regardless of whether compensation actually succeeded.** Customer is charged. Inventory is locked as reserved. Order says cancelled. Money captured with no automated reconciliation.

### Webhook delivery has no idempotency key for receivers
**File:** `modules/webhooks/worker.ts:106-117`

If the target returns 200 but the framework's local DB insert fails, the next attempt re-delivers. No event UUID in the payload to help receivers dedupe. We dedupe *inbound* webhooks (`processedWebhookEvents` table) but provide no help for *outbound* receivers to do the same.

### Stuck `processing` jobs have no reaper
**File:** `kernel/jobs/runner.ts:39-67` (claim) vs `runner.ts:78-148` (execute)

A lambda that times out mid-job leaves the row in `processing` forever. No heartbeat (`processingStartedAt` is set once and never refreshed). No reaper job. No visibility timeout. The row rots.

### `requestId` propagation gaps
- `requestId` is generated per HTTP request (`server.ts:97-129`).
- It does **not** propagate to background jobs (`commerce_jobs.input` doesn't carry it).
- It does **not** propagate to webhook deliveries (no `x-correlation-id` header in outbound `fetch`).
- A webhook fired from order creation cannot be traced back to the originating HTTP request.

### Observability gaps
- **No OpenTelemetry, no tracing.** Grep for `otel|opentelemetry|tracer|tracing` returns zero hits.
- **No slow-query logging.** Drizzle accepts a `logger` option in `drizzle()`; the postgres adapter calls `drizzle(client)` with no logger.
- **No metrics.** No counters for `webhooks_delivered_total`, `jobs_failed_total`, `compensation_invoked_total`, etc.
- **No `/healthz` endpoint.**
- **`hookErrors` returned in `Result.metadata` are silently ignored** by most callers.

### The 3 AM Test (questions the codebase can't answer)

| Question | Can you answer it with the current codebase? |
|----------|----------------------------------------------|
| "Webhooks have been failing for 4 hours. What's the trace of the originating order?" | ❌ — no `requestId` in jobs |
| "What did the customer's webhook endpoint actually return?" | ❌ — only `statusCode` is stored, not response body |
| "Replay a single failed webhook delivery." | ❌ — no admin "retry this delivery" route |
| "Pause webhooks to one bad endpoint." | ❌ — no per-endpoint pause |
| "Compensation failed; customer charged; order cancelled. Where do I look?" | ❌ — no structured `compensation_failed` event; grep stdout |
| "Tenant A is seeing Tenant B's data." | ❌ — no per-org request tracing; can't distinguish `storeResolver` failure from plugin-direct-DB-access |
| "Cold-start latency went 200ms → 2s. What changed?" | ❌ — no module-init timing instrumentation |
| "Job stuck in `processing` for 6 hours." | ❌ — no reaper; manual `UPDATE` is the only fix |
| "Inventory adjustment was lost (oversell by 3 units)." | ❌ — `inventory_movements` won't show the race because LB-4 silently overwrites |

This is what "framework-grade reliability" actually requires. The current state is "ships the happy path, hopes for the best on failure modes."

---

## 7. Strategic Position and Market Reality

### The market opportunity is real
- **PayloadCMS was acquired by Figma in June 2025.** It will not be extracted into a generic framework. The "PayloadCMS-pattern but generic" position is **vacant and unlikely to be filled by Payload itself.** This is a real opening.
- **MCP adoption is real, not hype.** 78% enterprise penetration (April 2026). 97M monthly SDK downloads. 81K GitHub stars. Donated to Linux Foundation's Agentic AI Foundation.
- **Hono has won the bottom layer.** Any new framework competes on what it adds *on top of* Hono — not against it. UC's positioning aligns with this.
- **The gap exists.** No framework is "AdonisJS-style batteries + Hono-portable + Drizzle-native + plugin-as-config-transform + MCP-first." NestJS owns enterprise OOP; AdonisJS is Node-bound; Encore.ts has no plugin story; Blitz.js is a zombie (last release Nov 2025).

### The market opportunity has hard timing
- **The agentic commerce *infrastructure* layer already has 50+ funded competitors** (Insignia VC landscape, April 2026). Six competing protocols (ACP, UCP, AP2, MCP, A2A, Visa TAP).
- The **operational** commerce angle (merchant automation: pricing, inventory, catalog, support) is defensible with MCP.
- The **transactional** consumer angle (agentic checkout) is going to settle on ACP/UCP, not pure MCP. Don't bet on MCP for consumer-side.
- "MCP-first as a framework positioning" is loud-by-itself for ~12 months and then becomes table stakes.

### The hard truths

**No LICENSE file at the repo root** or in `packages/core/package.json`. The only LICENSE in the tree is `apps/fashion-starter/LICENSE` (MIT, **Copyright 2022 Medusa** — inherited from a fork). Un-licensed code is "all rights reserved" by default. **Day 1 issue regardless of any framework decision.**

**Bus factor of 1.** Git log shows essentially solo development. A public TypeScript framework with a flagship commerce engine + agentic layer + 14 plugins + 10 adapters is a 2–3 full-time-engineer minimum product. Reference team sizes:
- AdonisJS: 5 core maintainers + Harminder Virk full-time + ~30 active community contributors
- NestJS: Kamil Myśliwiec full-time + 3 paid maintainers + sponsorship
- PayloadCMS pre-Figma: ~12 employees, $4.5M Series A, real company
- Medusa: ~30 employees, $8M raised
- Encore: Lightspeed Series A, ~$11M, ~15 employees

**The flagship has zero declared production customers.** Rails worked because Basecamp had revenue. Django worked because Lawrence Journal-World was a real publication. PayloadCMS worked because its own CMS was the proof. UC's README literally says "experimental — under active development. Not production-ready." Extracting a framework from a not-yet-validated flagship is putting foundation under a building that hasn't been occupied.

**Frameworks that failed with the "extract from flagship" pattern:** Sails.js (extracted from Balderdash, peaked 2015, abandoned 2023), Meteor.js (flagship lost to React/Next), FuelPHP, CakePHP. The pattern requires either (a) two distinct teams, (b) sponsor-funded full-time work, or (c) VC funding. Bus factor 1 + 65K lines is the textbook failure setup.

### Naming candidates (research-backed)
| Name | Pattern | Why it might work |
|------|---------|-------------------|
| **Praxis** | Greek: practical action | Matches "config is code" + "no theatre"; tagline: *"Conventions for transactional TypeScript"* |
| **Fora** | Latin: forum, marketplace; "outside" = extensible | One syllable, hard to find on npm, brand-able; tagline: *"The TypeScript framework for vertical SaaS"* |
| **Kiln** | Where things get forged | Small, hard, tactile; tagline: *"The kernel for things you sell"* |
| **Stratum** | Layer pattern | Matches the architecture; tagline: *"Layered TypeScript backends with first-class plugins and agents"* |

Constraints: must NOT be commerce-flavored (so future "Praxis for fitness booking" works), must NOT collide with existing npm packages (check `npm view <name>`).

**Recommended launch positioning:** *"AdonisJS for the Hono+Drizzle+MCP era."* Punchy, leverages incumbent recognition, instantly intelligible.

---

## 8. DX Papercuts That Block External Adoption

The framework is more hostile to external plugin authors than the architecture suggests. These are the things that show up in the first hour of trying to use it.

### The "first 5 minutes" story is broken

| Step | Reality |
|------|---------|
| Land on README | "Option 1: npm install — Note: Not yet published. Use Option 2." Fictional install path. |
| Clone + `bun install` | 32 workspace packages. |
| `cd apps/store-example && bun run dev` | Crashes with raw `pg` connection refused if Postgres isn't already running. README mentions prerequisites but not at the failure site. |
| Postgres running, `bun run dev` again | Crashes with `relation "user" does not exist`. No auto-bootstrap. Developer must find `db:push` script. |
| Server boots | `bunx unifiedcommerce api-key create` — but the CLI isn't built. Must `cd packages/cli && bun run build` first. |
| Run the command | Fails because `apiKeyScopes` isn't in the example's config. Error message is good (lists what to add). Developer adds them, retries. |
| First successful API call | ~5 minutes later, on a Mac/Linux native install with familiarity with Postgres. |

### The starter template ships broken
- Uses `database: { provider: "sqlite" }` — the engine only supports `"postgresql"`. Boots will fail.
- `package.json` declares `migrate` and `generate:migration` scripts but **no `drizzle.config.ts` ships in the template**. Running `bun run migrate` fails immediately.
- No `.env.example` despite config code referencing `process.env.DATABASE_URL`.
- `package.json` deps include `@unifiedcommerce/adapter-postgres` but `commerce.config.ts` doesn't import or use it.

### CLI gaps
The CLI has `init`, `dev`, `migrate`, `generate migration`, `deploy`, `import`, `api-key`. For a "batteries-included" framework, **missing**:
- `generate plugin <name>` — scaffold a plugin package
- `add @unifiedcommerce/plugin-X` — install + auto-update config files
- `seed` — there's a seed concept but no CLI command
- `studio` — drizzle-kit studio passthrough
- `routes` — list all registered routes (core + plugin)
- `hooks` — list all registered hook keys with handler counts (the introspection plugin authors actually need)
- `mcp:tools` — list registered MCP tools
- `doctor` — health check (DB reachable, all plugin schemas in drizzle.config.ts, auth tables exist, etc.)
- `build` / `start` — production-mode helpers

### Documentation reality
- **No `packages/core/README.md`.** The package being installed by every developer ships no README on npm.
- **Only 1 of 14 plugin packages has a README** (`plugin-marketplace/README.md`). The other 13 ship to npm without docs.
- `installation.mdx:78` shows the drizzle.config.ts schema glob as `"./packages/plugins/*/src/schema.ts"` — this is the **monorepo path**, not what an installed user would use. The store-example has the right glob (`./node_modules/@unifiedcommerce/plugin-*/src/schema.ts`). **The docs are demonstrably wrong for the documented install path.**

### The plugin author's IDE experience
- `PluginContext.services: Record<string, unknown>` — typing `ctx.services.` shows nothing. Author re-casts at every call site.
- `HookContext.services: ServiceContainer` is `{ [k: string]: unknown }` — same problem inside hooks.
- `HookContext.tx: unknown`, `HookContext.kernel: unknown` — the doc itself says "Cast to `Kernel` at usage sites to avoid circular imports."
- `BeforeHook<unknown>[]` arrays everywhere — author writes `beforeCreate: [(args) => args]` and `args` is `unknown`.
- Route handler `input: unknown` — plugin author re-casts: `const body = input as { amount: number; currency: string; ... }`, **redeclaring the Zod schema by hand**. The whole point of zod-openapi is to infer; this loses it.
- **`@ts-expect-error -- openapi handler union return type`** appears **73 times** in `packages/core/src/interfaces/`. Plugin authors copying a route file from core paste these in.
- No `Permissions` literal-union type. Typo `gift-cards:adminn` ships fine.

### The lifecycle footgun

The plugin author's first encounter with the lifecycle problem:

```typescript
// Looks like the obvious way:
giftCardPlugin()  // returns hooks: () => [], no service in hooks

// Actual correct way (undocumented in tutorials):
giftCardPluginWithHooks()  // uses Proxy<GiftCardService> lazy-ref pattern
```

The basic export silently omits the hooks. Real plugin authors will copy `giftCardPlugin` and end up with a hookless plugin and no error message.

### Misspelled hook keys silently no-op
Hook keys are `Record<string, Function[]>` keyed by arbitrary strings. `HookRegistry.append/prepend/registerConfigHooks` never validate the key against a known set. There's no warn-on-unknown-key, no autocompletion, no enum, no introspection endpoint. Plugin author writes `orders.aftercreate` (lowercase) and the hook never fires; nothing is logged.

### Hook payloads are `args: unknown`
The marketplace plugin shows the actual experience:
```typescript
async handler(args: unknown) {
  const { data } = args as { data: Record<string, unknown> };
  const metadata = data?.metadata as Record<string, unknown> | undefined;
  // 2-3 hand-written casts before any logic
}
```

Each handler is multiple casts before any logic.

### Build/test feedback loops
- The repo's test/typecheck scripts are tightly coupled to `turbo run` orchestration.
- A plugin author who clones a single plugin package out of the monorepo cannot run its tests — `@porulle/typescript-config` and `@porulle/eslint-config` are private workspace packages.
- Plugin test boot cost includes `drizzle-kit/api pushSchema(merged, db)` on every test boot. With 100 test files, this is hours of CI.
- No `test:watch` script in plugin starters.

---

## 9. The Updated Recommendation

Phase 1 said: *"Do the internal extraction. Publish externally when a second app emerges."*

**Phase 2 says: do the same, but pump the brakes harder. The internal extraction is still right, but the foundation needs significant repair before any external story is honest.**

### What changed

The Phase 1 wiki implied the codebase was 80% framework-ready and the remaining 20% was three concentrated debt files. Phase 2 confirms that *architecturally*, but reveals:

1. **Live bugs that ship today.** Not architecture debt — bugs. Webhooks broken for 6 modules. `inventory.adjust` lost-update. Order numbers race. Compensation failures vanish.
2. **Multi-tenancy isolation is held together by plugin author discipline**, not by the schema or the framework. Three critical hazards (MT-1, MT-3, MT-4) are silent data-leak vectors.
3. **Documented features that don't exist.** `extraColumns`, `manifest.permissions`, `commerce.api.giftCards.*`, `GET /api/admin/permissions`, `bunx create-unified-commerce`. The framework promises things it doesn't deliver.
4. **The "agnostic adapter" story is theatrical.** Hono and Drizzle have won at the type level. Be honest about what the framework actually is.
5. **The starter doesn't run.** Five-minute friction story is broken. No external developer survives this.
6. **No LICENSE.** Day-one legal issue.
7. **Bus factor 1 + zero production customers + 65K lines.** The strategic case for *publication* requires team or funding. Right now the project doesn't have either.

### The new sequencing

The Phase 1 plan was: extract → fix HookHandler → fix service container → introduce module system → publish.

**The Phase 2 plan adds three preconditions before "extract":**

1. **Stop the bleeding.** Fix the live bugs (LB-1 through LB-8) and the critical multi-tenancy hazards (MT-1, MT-3, MT-4). These are not framework concerns — they are correctness concerns in the commerce engine itself. They block production use today.

2. **Add the LICENSE file.** Choose MIT. Add it to repo root and every `packages/*/package.json`. This is a 30-minute task and should happen this week.

3. **Make the starter run.** The starter template is the on-ramp. If it doesn't boot, there's no framework. Fix the SQLite default, ship the `drizzle.config.ts`, write the `.env.example`, write a working `packages/core/README.md`.

Only then does the rest of the Phase 1 plan (`packages/framework` extraction, fix `HookHandler = never[]`, etc.) make sense.

### The honest framing of "publication"

Phase 1 said publish externally when a second app emerges. Phase 2 sharpens this:

**Publication preconditions (all must hold):**
- ≥1 public production customer of the commerce engine
- A second application internally validating the framework primitives
- A second maintainer (full-time or sponsor-funded) on the project
- All live bugs fixed
- LICENSE in place
- Starter boots in <5 minutes
- Documentation that doesn't lie about features
- `packages/core/README.md` exists
- The "AdonisJS for Hono+Drizzle+MCP era" story is publishable as a single essay

If any of these is false, the framework publication is premature.

---

## 10. The Pre-Extraction Punch List

Concrete, ordered, time-boxed. Do these before talking about a framework.

### Week 1 — Stop the bleeding
- [ ] **Add LICENSE files** — MIT to repo root, all `packages/*/package.json`. (30 min)
- [ ] **Fix LB-7 (order number race)** — replace `SELECT COUNT(*) + 1` with `nextval('order_number_seq')`. (1 day)
- [ ] **Fix LB-4 (inventory adjust lost update)** — implement OCC retry on `version` column or use `SELECT FOR UPDATE`. (1 day)
- [ ] **Fix MT-1 (storeResolver silent fallback)** — fail closed on `storeResolver` exception. (2 hours)
- [ ] **Fix MT-2 (resolveOrgId silent fallback)** — add `STRICT_ORG_RESOLUTION` env, default to strict for new installs. (1 day)
- [ ] **Fix LB-1 (webhook moduleName not set)** — set `context.context.moduleName` in all 6 affected services. (4 hours)

### Week 2 — Make it production-honest
- [ ] **Fix F-1 (compensation no remediation)** — persist compensation failures to a `compensation_failures` table; add operator endpoint. (2 days)
- [ ] **Fix F-6 (stuck processing jobs)** — add reaper for jobs older than `processingStartedAt + N min`. (1 day)
- [ ] **Fix LB-5 (webhook double-retry)** — pick one retry strategy, remove the other. (4 hours)
- [ ] **Fix LB-8 (URL alias double rate-limit)** — inject `type` into Hono context without re-dispatch. (1 day)
- [ ] **Fix LB-6 (process.exit in CF Workers)** — conditional on runtime detection. (2 hours)

### Week 3 — Make the starter run
- [ ] **Fix the starter template** — Postgres provider, ship `drizzle.config.ts`, `.env.example`, working README. (1 day)
- [ ] **Write `packages/core/README.md`** — published to npm with the package. (1 day)
- [ ] **Auto-boot DB on `bun run dev`** — detect missing tables and run `drizzle-kit push` automatically in dev. (1 day)
- [ ] **Add `unicore doctor`** — health check command for config + DB + auth tables + plugin schemas. (2 days)

### Week 4 — Remove the lies
- [ ] **Either implement or remove** `extraColumns`, `manifest.permissions`, `GET /api/admin/permissions`. Keep types honest. (1 day)
- [ ] **Either implement or update docstring** for `commerce.api.<plugin>.*` (LB-2). Plugin service registration or removal. (2 days)
- [ ] **Fix `installation.mdx`** — change schema glob from monorepo path to `node_modules` path. (10 min)
- [ ] **Fix `HookContext.db` typing** (LB-3) — type as `PluginDb | null` and force handlers to check. (4 hours)

### Week 5+ — The framework extraction (Phase 1's plan)
- [ ] Create `packages/framework` workspace package, move 30 framework-clean files. (3 days)
- [ ] Fix `HookHandler = never[]` (TD-003). (1 week)
- [ ] Fix `serviceContainer as Record<string, unknown>` (TD-002). (1 week)
- [ ] Land 1 production customer for the commerce engine. (Quarter 2 milestone)
- [ ] **Then and only then** evaluate external framework publication.

### Total honest estimate
**4–6 weeks of focused work** to bring the foundation to "publication-honest." Then 6–12 months of customer landing + framework consolidation before external publication is defensible.

---

## Appendix: The Phase 2 Findings Summary

| ID | Title | Severity | Phase 2 Subsection |
|----|-------|----------|---------------------|
| LB-1 | Webhooks broken for 6 of 8 modules | HIGH | §2 |
| LB-2 | `commerce.api.giftCards.*` is fictional | MEDIUM | §2 |
| LB-3 | `HookContext.db` is null except for orders | HIGH | §2 |
| LB-4 | `inventory.adjust()` lost-update bug | CRITICAL | §2 |
| LB-5 | Webhook double-retry (3×5=15) | HIGH | §2 |
| LB-6 | `process.exit` breaks Cloudflare Workers | HIGH | §2 |
| LB-7 | Order number race condition | HIGH | §2 |
| LB-8 | URL alias double rate-limit | HIGH | §2 |
| MT-1 | `storeResolver` failure → org_default leak | CRITICAL | §3 |
| MT-2 | `resolveOrgId(null)` silent fallback | HIGH | §3 |
| MT-3 | `inventory_levels` lacks `organization_id` | HIGH | §3 |
| MT-4 | Plugin raw DB access bypasses scoping | HIGH | §3 |
| MT-5 | Job adapter defaults to `org_default` | HIGH | §3 |
| MT-6 | Audit can't catch its own org-leak | MEDIUM | §3 |
| F-1 | Compensation failure has no remediation | CRITICAL | §6 |
| F-6 | Stuck `processing` jobs have no reaper | MEDIUM | §6 |

---

*Phase 2 research conducted May 2026. Companion to `FRAMEWORK-WIKI.md`. Subagents: implicit-contracts auditor, reliability engineer, strategic analyst, DX papercut auditor.*
