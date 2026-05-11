# Work Breakdown Structure — Foundation Repair (unified-commerce-engine)

> **The build plan, sprint by sprint, end-to-end.** Spans the two research wikis (`FRAMEWORK-WIKI.md` Phase 1 architectural extraction blueprint, and `FRAMEWORK-WIKI-PHASE-2.md` non-obvious findings: live bugs, multi-tenancy hazards, dead infrastructure, DX papercuts, strategic position). Every sprint is an end-to-end demoable slice that closes a specific tier of foundation debt. The mission across all six sprints: **bring the foundation to "production-honest" before anyone says the word "framework" out loud.**

---

## 1. Cadence and engineering practice

### 1.1 Cadence
- **1-week sprints.** Plan Monday morning. Phase A implementation Tuesday–Thursday. Phase B review (pi gate → r1 → codex r2 → fix pass) Friday. Warm-down Friday afternoon.
- **One sprint goal**, expressed as a single sentence with a verifiable outcome.
- **2–6 stories per sprint.** Smaller is better. Each story ships independently.
- **No carry-over.** If a story slips, it goes back to the backlog, not the next sprint as-is. Rewrite the story.

### 1.2 Definition of Done (universal)
A sprint's stories are collectively Done when **all** of the following hold:

1. Every story commits atomically (`[S{N}-{nn}] {title}`) to `main` behind a green CI run on the project's supported runtimes (Bun + Node 20).
2. Unit tests written for every new exported function / class. **Coverage is not the metric**; *behavioral coverage* is — every public surface tested with at least one happy-path and one failure-path test.
3. **Passes the four-role sprint-level review pipeline:** spec + code-quality gate by `pi`, manager critical r1 review, and (when source/test code shipped) adversarial r2 review by an independent `codex` worker.
4. **Public surfaces match the source wikis.** Diffs to `FRAMEWORK-WIKI*.md` require an explicit wiki amendment in the same sprint.
5. Telemetry / observability events match the project's documented event taxonomy. New events require an explicit doc amendment.
6. Docs updated: at minimum the package's README; at most a wiki delta or new RFC entry.
7. Manual demo artifact captured per story or per sprint (artifact format depends on what the work produces — `curl` transcript, test snapshot, screen-recording, log excerpt).
8. **No `--no-verify`, no type-suppression, no silent-catch shortcuts.** If you can't meet a check, change the design, not the gate.

### 1.3 Branching and commits
- Trunk-based on `main`. Cursor commits per-story atomic implementations directly. Manager commits the fix pass + closeout commits.
- Every commit message includes the story id (or `[S{N}-fix]` / `[S{N}-close]` for manager commits) and a body summarizing the diff.
- Demo artifact paths live in the commit body.

### 1.4 The review loop (four roles, sprint-level cadence)

The review pipeline runs **once per sprint**, after every story is committed. Four roles, four workers, four distinct value adds:

1. **Phase A — IC implementation.** `cursor` is fired as a fresh process per story. Writes the diff against the brief, runs build/test, **commits atomically** before exiting. Each story = one fresh cursor invocation = one clean context window.
2. **Phase B begins — Spec + code-quality gate.** `pi` reads every story brief + the entire sprint diff. Verifies acceptance criteria, file-list adherence, wiring, test quality. **Same team as the IC; NOT adversarial.** Output: `sprints/sprint-N/gate-sprint.md` with verdict `green` / `yellow` / `red`.
3. **Manager critical review (r1).** Main session reads the gate report + the diff and writes `sprints/sprint-N/review-sprint-r1.md` using the sandwich method — strengths, critique with severity, constructive close. Manager owns the final diff.
4. **Adversarial second-opinion review (r2).** When the sprint includes source/test code, `codex` reads gate + r1 + diff and writes `sprints/sprint-N/review-sprint-r2.md`. Finds non-obvious bugs (race conditions, type holes, untested paths). Critiques r1 itself if wrong. The strongest spec + quality + adversarial gate. **Skip rule:** if the sprint has zero source/test changes, r2 is skipped; document in the fix-pass commit body.
5. **Manager fix pass.** Apply every `Apply now` item from gate + r1 + r2. Commit `[S{N}-fix] {description}`. Sprint closes when WARMDOWN + HANDOFF + STATE-update commit lands.

### 1.5 Sprint warm-down (handoff to the next session)
Last hour of every sprint. Two artifacts:

1. `sprints/sprint-N/WARMDOWN.md` — what shipped, what's working, what's not, open issues, decisions made, wiki amendments this sprint.
2. `sprints/sprint-N/HANDOFF.md` — a one-page primer for the next session: read-me-first, current state of the world, sprint N+1 starting state.

The next session reads HANDOFF first, WARMDOWN if it needs depth.

---

## 2. The roadmap

| Sprint | Phase | Goal (one sentence) |
|--------|-------|---------------------|
| 0 | **Foundation hygiene + critical correctness** | License the project, fix three silent data-corruption bugs (inventory lost-update, order-number race, compensation-failure-without-remediation), and make the starter template boot. |
| 1 | **Multi-tenancy hardening** | Close every cross-tenant data-leak vector by failing closed on org resolution and adding `organization_id` to inventory tables. |
| 2 | **Live bug fixes + reaper** | Fix the six live bugs that ship today (broken webhooks, double-retry, edge-runtime crash, alias rate-limit, null hook DB, stuck jobs). |
| 3 | **Documentation honesty + onboarding** | Either implement or delete every documented-but-unimplemented feature; ship working READMEs and a `unicore doctor` health check. |
| 4 | **Service container modernization** | Replace `serviceContainer as Record<string, unknown>` with a typed module system, eliminating inter-service `as` casts. |
| 5 | **Typed hooks + framework extraction** | Replace `HookHandler = (...args: never[]) => unknown` with a typed hook map, fix `getMCPActor`, and move the 30 framework-clean files into `packages/framework`. |

The phases above map to the source wikis as follows:

- **Sprint 0** → `FRAMEWORK-WIKI-PHASE-2.md` §10 Tier 0 (correctness) + Tier 3 #15–17 (LICENSE, starter, core README).
- **Sprint 1** → `FRAMEWORK-WIKI-PHASE-2.md` §3 (Multi-Tenancy Hazards MT-1 through MT-5).
- **Sprint 2** → `FRAMEWORK-WIKI-PHASE-2.md` §2 (Live Bugs LB-1, LB-3, LB-5, LB-6, LB-8) + §6 (F-6 stuck-jobs reaper).
- **Sprint 3** → `FRAMEWORK-WIKI-PHASE-2.md` §4 (Dead Infrastructure) + §8 (DX Papercuts: plugin READMEs, installation.mdx fix, doctor command).
- **Sprint 4** → `FRAMEWORK-WIKI.md` §7 TD-002 + `FRAMEWORK-WIKI.md` §9 (Module System API design).
- **Sprint 5** → `FRAMEWORK-WIKI.md` §7 TD-003 (typed hooks) + TD-002 finish + `FRAMEWORK-WIKI.md` §11 Phase 1 (extract `packages/framework`).

---

## 3. Sprint detail

The format below repeats per sprint. Each sprint embeds a **concise RFC** (problem / goal / non-goals / approach / risks) plus the story table. Stories use the id pattern `S{N}-{nn}` (e.g. `S0-01`).

---

### Sprint 0 — Foundation Hygiene + Critical Correctness

**Goal:** License the project, fix three silent data-corruption bugs (inventory lost-update, order-number race, compensation-failure-without-remediation), and make the starter template boot.

#### RFC-S0 — Stop the bleeding before talking about a framework

**Problem.** Three classes of issue make any "framework" conversation premature: (a) the repo has no LICENSE file, so every package is technically "all rights reserved" (legal blocker for any external eyes); (b) `inventory.adjust()` does read-modify-write without a row lock, causing silent lost updates under concurrency; (c) order numbers are generated as `SELECT COUNT(*) + 1`, racing under load; (d) compensation failures (e.g., `inventory.release` throws after `payment.capture` succeeded) are logged to stdout and abandoned — money captured + order cancelled with no remediation record; (e) the starter template ships unsupported `sqlite` provider and no `drizzle.config.ts` — the very first developer to clone and run gets a crash with no recoverable error path.

**Goal.** After this sprint: (1) every package carries a license; (2) inventory adjustments are atomic under any concurrency; (3) order numbers are monotonic and unique; (4) compensation failures are persisted and operator-queryable; (5) `bunx @unifiedcommerce/cli init && cd && bun run dev` boots a working server in under five minutes on a fresh machine.

**Non-goals.** Multi-tenancy fixes (Sprint 1). Webhook event-name fix (Sprint 2). Framework extraction (Sprint 5). New features of any kind.

**Approach.**
- License: MIT, applied to repo root + every `packages/*/package.json` `"license"` field.
- `inventory.adjust()`: switch to `SELECT ... FOR UPDATE` on the level row inside the existing transaction — same pattern `reserveWithLock` already uses (`modules/inventory/service.ts`). Keep the `version` column; populate-but-don't-rely-on for now.
- Order numbers: introduce `CREATE SEQUENCE order_number_seq` migration. Replace `getNextOrderNumber()` with `SELECT nextval('order_number_seq')`. Backfill existing orders via one-shot script.
- Compensation failures: new `compensation_failures` table (id, order_id, original_error, compensation_error, occurred_at, resolved_at, resolved_by). `runCompensationChain()` writes a row on any reverse-step failure. New admin route `GET /api/admin/compensation-failures` to list, `POST /api/admin/compensation-failures/:id/resolve` to mark resolved.
- Starter: switch provider to `postgresql`, ship a working `drizzle.config.ts` referencing `node_modules` paths, ship `.env.example`, write a minimal but accurate README.

**Risks.**
- *Backfilling order numbers*: existing rows must keep their numbers. Mitigation: set `nextval()` cursor to `(SELECT MAX(numeric_part) + 1 FROM orders)` before going live.
- *Migration ordering*: `compensation_failures` table must exist before code that writes to it ships. Mitigation: ship the migration story (S0-04) before the code story (S0-05).
- *MIT vs alternatives*: chose MIT for ecosystem alignment with Hono / Drizzle / Better Auth (all MIT). Apache-2.0 has a patent grant; we accept that risk for adoption.

#### Stories

| Story | Description | DoD |
|-------|-------------|------|
| S0-01 | Add MIT LICENSE file at repo root + `"license": "MIT"` in every `packages/*/package.json`. | All 32 packages publish with a license; root LICENSE file present; CI lint asserts presence. |
| S0-02 | Replace `inventory.adjust()` read-modify-write with `SELECT FOR UPDATE`. Add concurrency test that fires 50 parallel adjusts and asserts the final balance. | Test currently fails on `main`; passes after the change. |
| S0-03 | Migrate to `order_number_seq` PostgreSQL sequence. Replace `getNextOrderNumber()` body. Backfill script under `packages/db/scripts/backfill-order-seq.ts`. | New orders use `nextval()`; existing orders unchanged; backfill script idempotent. |
| S0-04 | Add `compensation_failures` table migration + repository in `packages/core/src/kernel/compensation/repository.ts`. | Migration applies cleanly; repository has `record()`, `list()`, `markResolved()` with tests. |
| S0-05 | Wire `compensation_failures` into `runCompensationChain()`. Add admin routes `GET /api/admin/compensation-failures` and `POST /api/admin/compensation-failures/:id/resolve` (admin-permission-gated). | Forced compensation failure persists a row; admin endpoint lists and resolves it. |
| S0-06 | Fix starter template: postgresql provider, working `drizzle.config.ts`, `.env.example`, README. Author `packages/core/README.md`. | `bunx @unifiedcommerce/cli init demo && cd demo && bun install && bun run dev` boots in under 5 min on a clean machine. |

**Demo:** A single recorded terminal session showing: (1) `cat LICENSE` → MIT; (2) parallel-adjust test passing; (3) two concurrent order creations producing `2026-001`, `2026-002`; (4) forced compensation failure with `curl /api/admin/compensation-failures` listing the row; (5) `bunx … init demo && cd demo && bun run dev` reaching "Server listening on :4000".

**Dependencies:** None.

**Source RFC §:** `FRAMEWORK-WIKI-PHASE-2.md` §10 Tier 0 + Tier 3 (#15, #16, #17).

**Sprint-specific risks:**
- *S0-02 may surface deadlocks in tests*: pgbouncer transaction-mode pool can't hold `SELECT FOR UPDATE` across statements. Detection: test suite hangs. Mitigation: use session-mode pool in tests; document the prod-pool requirement.
- *S0-05 admin route surface*: must be admin-gated, not added to `apiKeyScopes` of public scope. Detection: codex r2 will catch a missing permission. Mitigation: scope `compensation:admin` in the brief.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared; STATE.md points at Sprint 1.

---

### Sprint 1 — Multi-Tenancy Hardening

**Goal:** Close every cross-tenant data-leak vector by failing closed on org resolution and adding `organization_id` to inventory tables.

#### RFC-S1 — Tenant isolation must fail closed, not silently fall back

**Problem.** Five distinct tenant-isolation failures, any of which is a silent cross-tenant data leak: (MT-1) `storeResolver` exception silently routes the request to `org_default` via empty `catch {}` block at `auth/middleware.ts:179-204`; (MT-2) `resolveOrgId(null)` has a four-level fallback chain ending in literal `"org_default"` with no fail-closed mode; (MT-3) `inventory_levels` and `inventory_movements` lack `organization_id` columns — isolation depends on indirect warehouse joins that any plugin can bypass; (MT-4) plugins receive raw `database.db` (Drizzle handle) bypassing the scoped proxy entirely; (MT-5) `DrizzleJobsAdapter.enqueue()` defaults `organizationId` to `org_default` when callers forget to pass it.

**Goal.** After this sprint: every request that lacks an unambiguous org context fails with 503 (configurable to legacy-fallback for backwards compat); every inventory row carries an explicit `organization_id`; plugins receive a scoped DB handle by default with explicit `database.unscoped` as the escape hatch; jobs require explicit `organizationId` at enqueue time.

**Non-goals.** Replacing Better Auth (out of scope; Better Auth's `organization` plugin is the multi-tenancy substrate). Row-level security via `pgPolicy` (defer to a future sprint when we have audit data showing it's needed).

**Approach.**
- **Fail-closed `storeResolver`**: replace empty `catch {}` with explicit `503 Service Unavailable` response when configured resolver throws. Add `STRICT_ORG_RESOLUTION=false` env var to opt back into legacy fallback for backwards compat.
- **Strict `resolveOrgId`**: same env-var mode. When `STRICT_ORG_RESOLUTION=true` (default for new installs, **opt-in** for existing), null actor + no defaultOrgId → throw `OrgResolutionError` instead of returning `"org_default"`.
- **Inventory schema migration**: add `organization_id` (NOT NULL, FK to `organization.id`) to `inventory_levels` and `inventory_movements`. Backfill from `warehouse.organization_id`. Add CHECK constraint that `organization_id = warehouse.organization_id`.
- **Scoped plugin DB**: `PluginContext.database.db` becomes the scoped proxy by default. Add `PluginContext.database.unscoped` as explicit escape hatch (with deprecation warning logged). Update `kernel/plugin/manifest.ts` and `runtime/kernel.ts:226`.
- **Explicit jobs org**: `EnqueueOptions.organizationId` becomes required (TypeScript type change). Existing plugin-internal callers updated to pass it explicitly.

**Risks.**
- *Strict mode breaks existing single-store deployments*: opt-in with `STRICT_ORG_RESOLUTION=true` for new installs only; document migration path.
- *Inventory backfill can't always find an org*: if any row references a missing warehouse, backfill assigns to `DEFAULT_ORG_ID` and logs a warning. Manual cleanup by operator.
- *Scoped DB by default breaks plugins*: change is breaking for plugins that did unscoped queries. Acceptable — those plugins were buggy. Surface in CHANGELOG.

#### Stories

| Story | Description | DoD |
|-------|-------------|------|
| S1-01 | Replace empty `catch {}` in `storeResolver` path with explicit 503 + `OrgResolutionError`. Add `STRICT_ORG_RESOLUTION` env var (default `true` for new, `false` for legacy). | Test: forced `storeResolver` throw → 503 in strict mode; legacy fallback only when env var is `false`. |
| S1-02 | Apply same fail-closed treatment to `resolveOrgId(null)`. Throw `OrgResolutionError` in strict mode; preserve fallback chain in legacy mode. | All four fallback levels exercised by tests in both modes. |
| S1-03 | Migration: add `organization_id` (NOT NULL, FK) to `inventory_levels` + `inventory_movements`. Backfill from `warehouse.organization_id`. Add CHECK constraint. | Migration runs cleanly on a seeded DB; CHECK constraint rejects mismatched inserts. |
| S1-04 | Update inventory repository to write/read `organization_id` explicitly. Verify cross-org reads return zero rows. | Cross-org test: actor for org A cannot read inventory rows belonging to org B. |
| S1-05 | Make `PluginContext.database.db` the scoped proxy. Add `database.unscoped` escape hatch with deprecation log. Update `manifest.ts` types. | Existing plugin tests pass; new test asserts unscoped query logs a warning. |
| S1-06 | `DrizzleJobsAdapter.enqueue()` requires explicit `organizationId` (TypeScript breaking change). Update gift-cards / loyalty / marketplace plugin call sites. | Type compiles only when callers pass `organizationId` explicitly; jobs run scoped to the right org. |

**Demo:** A `pytest`-style integration suite recording: (1) curl with bogus `storeResolver` throwing → 503 not 200; (2) `psql` showing the new `organization_id` columns + CHECK constraint; (3) a forged plugin attempting cross-org read returning zero rows; (4) typecheck of plugin code that omits `organizationId` failing at compile time.

**Dependencies:** Sprint 0 (LICENSE in place, foundation correctness).

**Source RFC §:** `FRAMEWORK-WIKI-PHASE-2.md` §3 (MT-1 through MT-5).

**Sprint-specific risks:**
- *S1-03 backfill on production-sized data*: tens of millions of `inventory_movements` rows. Detection: migration runtime > 10 min in staging. Mitigation: run as `ALTER TABLE ... ADD COLUMN ... DEFAULT NULL; UPDATE ... SET ...; ALTER TABLE ... ALTER COLUMN ... SET NOT NULL` in three statements.
- *S1-05 breaks plugins-in-the-wild*: gift-cards plugin uses raw `db` for some admin queries. Detection: gift-cards e2e fails. Mitigation: explicit `database.unscoped` calls in admin routes, with eslint rule warning on usage.

**Exit criteria:** all stories Done; cross-org test suite green; WARMDOWN written; HANDOFF prepared.

---

### Sprint 2 — Live Bug Fixes + Reaper

**Goal:** Fix the six live bugs that ship today (broken webhooks, double-retry, edge-runtime crash, alias rate-limit, null hook DB, stuck jobs).

#### RFC-S2 — Production code that doesn't actually work

**Problem.** Six bugs that ship with the engine today: (LB-1) webhooks fire as `unknown.create` for catalog/cart/customers/pricing/promotions/fulfillment because only `OrderService` and `InventoryService` set `context.context.moduleName` — every subscriber filtering on event name misses these; (LB-3) `HookContext.db` is typed as non-null `PluginDb` but is `null` for every module except `orders` (only `OrderService` threads `kernel` through `createHookContext`); (LB-5) webhook double-retry of 3 inner × 5 outer = 15 attempts back-to-back with no sleep; (LB-6) `process.exit(1)` on `unhandledRejection` crashes Cloudflare Workers (which the README claims to support); (LB-8) URL alias re-dispatch via `app.fetch()` re-enters all middleware including rate limiter, double-counting client quota; (F-6) jobs stuck in `processing` state have no reaper — a lambda timeout leaves the row stranded forever.

**Goal.** After this sprint: webhook delivery works for every wired module; hook-context `db` is honestly typed and either always present or `null`-checked; webhook retry follows a single strategy with exponential backoff; the engine boots cleanly on Cloudflare Workers; alias requests count once against rate-limit quota; stuck jobs reap automatically.

**Non-goals.** Distributed-tracing instrumentation (separate work, defer). OpenTelemetry integration (defer). Webhook payload idempotency keys (consider in Sprint 5 with framework extraction).

**Approach.**
- **LB-1 (webhook moduleName)**: each of the 6 affected services sets `context.context.moduleName` before invoking after-hooks. Single-line change per service. Add a guardrail test: subscribe to `catalog.afterCreate`, create a catalog entity, assert the webhook payload's event name is `catalog.afterCreate` not `unknown.create`.
- **LB-3 (HookContext.db null)**: two-step. (a) Type as `PluginDb | null` (breaking type change). (b) Thread `kernel` through every service constructor so `db` is always populated. Pick (b) — it's more work but eliminates the null case for plugin authors.
- **LB-5 (webhook double-retry)**: rip out the inner `while (attempt < maxAttempts)` loop. Keep job-level `attempts: 5` with exponential backoff. Add `retry_after_ms` in payload for receiver-side dedupe.
- **LB-6 (process.exit on edge)**: `if (typeof process !== "undefined" && typeof process.on === "function") { process.on("unhandledRejection", ...) }`. Edge runtimes get a no-op.
- **LB-8 (URL alias double rate-limit)**: drop `app.fetch()` re-dispatch. Inject `c.req.query.type = "product"` directly in a middleware that runs before the route handler.
- **F-6 (stuck jobs reaper)**: new scheduled task `staleJobReaper` that runs every minute, finds rows where `status = 'processing'` and `processing_started_at < now() - 5 min`, sets them back to `pending` with `attempts -= 1` (so they don't retry forever).

**Risks.**
- *LB-3 thread-kernel-everywhere is invasive*: touches all 17 service constructors. Mitigation: single mechanical change with a strong type signature; cursor handles it well.
- *Reaper race with active worker*: a worker writing `succeeded` at the same moment the reaper writes `pending`. Mitigation: reaper uses `WHERE status = 'processing' AND processing_started_at < ?` so the worker's `WHERE id = ? AND status = 'processing'` either sees `processing` (worker wins) or `pending` (reaper won; worker's update is a no-op).

#### Stories

| Story | Description | DoD |
|-------|-------------|------|
| S2-01 | LB-1: set `context.context.moduleName` in catalog, cart, customers, pricing, promotions, fulfillment services. Add per-module assertion tests. | Webhook subscriber receives `catalog.afterCreate` not `unknown.create`. Test runs across all 6 modules. |
| S2-02 | LB-3: thread `kernel` through every service constructor; `HookContext.db` is always populated, never null. Update `kernel/hooks/types.ts` to remove the lying type. | Cross-module hook handler can write to `ctx.db` without runtime crash. |
| S2-03 | LB-5: remove inner retry loop in `webhooks/worker.ts`. Keep job-level retry with exponential backoff. Add idempotency hint in payload. | Failing endpoint hit at-most 5 times with backoff; receiver-side test confirms `Webhook-Id` header for dedupe. |
| S2-04 | LB-6: guard `process.on(...)` with runtime detection. Edge runtimes get a no-op. | Test under simulated edge runtime (`process` undefined) does not throw at boot. |
| S2-05 | LB-8: drop `app.fetch()` re-dispatch for URL aliases. Inject `type` query param via middleware. | Alias request increments rate limiter once, not twice; test against `/api/products` proves single increment. |
| S2-06 | F-6: stale-job reaper task. Scheduled every minute. Logs each reaped job. | Test: insert a row with `status = 'processing'` and `processing_started_at = now() - 10 min`; run reaper; assert row returned to `pending`. |

**Demo:** Recorded session showing: (1) tail of webhook subscriber receiving correctly-named events for all 6 modules; (2) hook handler reading `ctx.db.select(...)` from a catalog hook (not orders) without crash; (3) failing endpoint logs showing 5 attempts with backoff (not 15 back-to-back); (4) wrangler dev (CF Workers) boots without error; (5) alias request rate-limit counter incrementing by 1 not 2; (6) reaper log line "reaped 3 stuck jobs from worker $WORKER_ID".

**Dependencies:** Sprint 1 (org-strict mode is on; all paths must respect it).

**Source RFC §:** `FRAMEWORK-WIKI-PHASE-2.md` §2 (LB-1, LB-3, LB-5, LB-6, LB-8) + §6 (F-6).

**Sprint-specific risks:**
- *S2-02 cascades through 17 services*: largest single-story diff in the entire 6-week plan. Detection: codex r2 is likely to flag this as risky. Mitigation: split into S2-02a (type change) and S2-02b (thread kernel) if r1 says so during planning.
- *S2-06 reaper interferes with valid long-running jobs*: any handler that legitimately runs > 5 min will be reaped. Mitigation: reaper threshold configurable via env var; document the trade-off.

**Exit criteria:** all stories Done; the six live bugs are closed; WARMDOWN; HANDOFF.

---

### Sprint 3 — Documentation Honesty + Onboarding

**Goal:** Either implement or delete every documented-but-unimplemented feature; ship working READMEs and a `unicore doctor` health check.

#### RFC-S3 — The framework promises things it doesn't deliver

**Problem.** Six features are documented (in JSDoc, README, type definitions, or installation docs) but don't actually work: (a) `extraColumns` / `mergeExtraColumns` is exported and referenced by `PaymentAdapter.extraColumns()` but called nowhere; (b) `manifest.permissions` is collected and never published; the JSDoc-promised `GET /api/admin/permissions` route doesn't exist; (c) `commerce.api.giftCards.checkBalance(...)` is documented in `kernel/local-api.ts:24-27` but plugin services never register into `kernel.services` (LB-2); (d) catalog `beforeRead/afterRead/beforeList/afterList` are in `EntityHooks` types but the catalog service never invokes them; (e) `customerPermissions` config is hardcoded twice in `auth/middleware.ts` rather than read from config; (f) `bunx create-unified-commerce` is referenced in README "Option 1" but doesn't exist. Plus: `installation.mdx` shows the wrong drizzle schema glob (monorepo path, not `node_modules` path users actually need); 13 of 14 plugin packages ship without READMEs; the first-five-minutes onboarding story is broken (no auto-bootstrap, no doctor command).

**Goal.** After this sprint: every documented feature either works or its docstring is deleted. Every plugin package has a usable README. New developers can run `unicore doctor` to validate their setup. The first-five-minutes story is recorded and works.

**Non-goals.** Implementing a full plugin-service-registration mechanism (that's Sprint 4 module system work — for now, delete the JSDoc claim). Generating plugin scaffolders (`unicore generate plugin`) — defer to post-extraction.

**Approach.**
- **Decide once per dead-feature**: implement or delete. Most get deleted (the cost of implementing extraColumns is too high for current value).
  - `extraColumns` / `mergeExtraColumns`: **delete**. Remove from `kernel/schema/extra-columns.ts` exports; remove `PaymentAdapter.extraColumns?()` from interface.
  - `manifest.permissions`: **implement** the read side (`GET /api/admin/permissions` returns the collected scopes); leave validation-against-routes as a backlog item.
  - `commerce.api.giftCards.*`: **delete the JSDoc claim**. Add a comment that plugin services live in `ctx.services` not `commerce.api`. Real fix waits for Sprint 4.
  - Catalog read/list hooks: **implement**. Wire `runBeforeHooks/runAfterHooks` calls into catalog service `getById`, `list` paths.
  - `customerPermissions` duplication: **delete duplicate**. Read from config in both call sites.
  - `bunx create-unified-commerce`: **delete the README section**. Replace with `bunx @unifiedcommerce/cli init <name>` (which works).
- **Plugin READMEs**: write a 30–80 line README for each of the 13 missing plugins (template + plugin-specific section). Same template for all; cursor can handle this in one story.
- **`installation.mdx` fix**: change schema glob to `node_modules/@unifiedcommerce/plugin-*/src/schema.ts`.
- **`unicore doctor` command**: new CLI command that checks: DB reachable, all `customSchemas` paths covered in `drizzle.config.ts`, auth tables exist, env vars set, all required adapters configured.
- **Auto-bootstrap on `dev`**: detect missing core tables and run `drizzle-kit push` automatically in dev mode (gated on `NODE_ENV !== 'production'`).

**Risks.**
- *Deleting documented features upsets users*: this is a pre-1.0 project and the README explicitly says experimental. Acceptable. Document the deletions in CHANGELOG.
- *Catalog read/list hooks have unclear payload shapes*: define typed payload interfaces in this sprint; document as the canonical shape.

#### Stories

| Story | Description | DoD |
|-------|-------------|------|
| S3-01 | Delete `extraColumns` / `mergeExtraColumns` infrastructure. Remove `PaymentAdapter.extraColumns?()` from interface. Update CHANGELOG. | All references gone; CI green; CHANGELOG entry. |
| S3-02 | Implement `GET /api/admin/permissions` returning collected `manifest.permissions[]`. Admin-gated. | Test: register plugin with permissions → endpoint returns them. |
| S3-03 | Delete the `commerce.api.giftCards.*` JSDoc claim from `kernel/local-api.ts`. Add accurate comment about `ctx.services`. | JSDoc reflects reality; no examples that don't work. |
| S3-04 | Wire catalog `beforeRead/afterRead/beforeList/afterList` hooks into catalog service `getById` and `list`. Define typed payload interfaces. | Test: register a `catalog.beforeList` hook → invoked when listing. |
| S3-05 | Deduplicate `customerPermissions` — read from config in both `auth/middleware.ts:14-24` and `:193-198`. | Single source of truth; test override via config works. |
| S3-06 | Fix `installation.mdx` drizzle schema glob to use `node_modules` path. Delete `bunx create-unified-commerce` section from root README. Replace with working `bunx @unifiedcommerce/cli init` reference. | Onboarding instructions match reality; followed verbatim, they work. |
| S3-07 | Write READMEs for the 13 plugin packages without one. Common template (Install / Config / Usage / Hooks Exposed / MCP Tools). | All 14 plugin packages have READMEs published to npm. |
| S3-08 | New `unicore doctor` CLI command. Checks DB reachable, drizzle config glob covers all customSchemas, auth tables exist, env vars set. Exits non-zero on failure with actionable messages. | Manually break each precondition; doctor reports the right one with the fix. |
| S3-09 | Auto-bootstrap on `bun run dev`: if core tables missing and `NODE_ENV !== 'production'`, run `drizzle-kit push` automatically with a console warning. | Fresh DB; `bun run dev` boots end-to-end without manual `db:push`. |

**Demo:** Recorded "first 5 minutes": fresh machine → `bunx @unifiedcommerce/cli init demo` → `cd demo` → `bun install` → `bun run dev` → server boots → `unicore doctor` reports green → first request succeeds. Total elapsed ≤ 5 min.

**Dependencies:** Sprint 0 (starter template works), Sprint 1 (org-strict mode means `doctor` checks org config).

**Source RFC §:** `FRAMEWORK-WIKI-PHASE-2.md` §4 (Dead Infrastructure) + §8 (DX papercuts).

**Sprint-specific risks:**
- *S3-04 catalog read hooks are a behavior change*: any code path that assumed reads bypass hooks now hits them. Detection: catalog list test suite slowdown. Mitigation: hooks default to no-op handler list — perf regression bounded.
- *S3-08 doctor scope creep*: temptation to add 50 checks. Mitigation: brief pins the check list to the 6 named conditions.

**Exit criteria:** all stories Done; documentation matches code; WARMDOWN; HANDOFF.

---

### Sprint 4 — Service Container Modernization

**Goal:** Replace `serviceContainer as Record<string, unknown>` with a typed module system, eliminating inter-service `as` casts.

#### RFC-S4 — The property-bag antipattern is the largest type-safety hole

**Problem.** `serviceContainer = services as Record<string, unknown>` at `runtime/kernel.ts:223` is the foundational type-safety hole. Every cross-service call inside the codebase does `this.deps.services.inventory as { adjust(...): ... }` — five times in `orders/service.ts` alone. Each cast is independently unchecked: a method-signature change in `InventoryService` produces zero compile errors at the five `OrderService` call sites. The intended escape hatch (`ServiceRegistry` type at `kernel/service-registry.ts`) exists but is never used because services accept `Record<string, unknown>` rather than `ServiceRegistry` in their constructor types. Plugin authors inherit the same property-bag — `PluginContext.services: Record<string, unknown>` defeats IDE autocomplete entirely (an IDE typing `ctx.services.` shows nothing).

**Goal.** After this sprint: services declare their cross-service dependencies explicitly via a typed `defineModule({ id, dependencies: ['pricing'], service: (deps) => ... })` API. The kernel constructs a typed `ServiceMap<TModules>` so `deps.services.pricing` is fully typed inside every module. Plugin authors get autocomplete on `ctx.services.{coreServiceName}`. The five inline `as { ... }` casts in `orders/service.ts` become zero.

**Non-goals.** Hook system retyping (Sprint 5). Framework extraction (Sprint 5). Decorator-based DI (rejected in `FRAMEWORK-WIKI.md` §10). NestJS-style `@Injectable()` (same).

**Approach.**

Module API design (from `FRAMEWORK-WIKI.md` §9):

```typescript
interface AppModule<TSchema, TService, TDeps extends Record<string, unknown> = {}> {
  id: string;
  schema: () => TSchema;
  dependencies?: ReadonlyArray<keyof TDeps>;
  service: (deps: ModuleDeps<TDeps>) => TService;
}

interface ModuleDeps<TDeps> {
  db: DatabaseAdapter;
  hooks: HookRegistry;
  services: TDeps;
  config: AppConfig<any>;
  logger: Logger;
}

function defineModule<TSchema, TService, TDeps>(
  manifest: AppModule<TSchema, TService, TDeps>
): AppModule<TSchema, TService, TDeps>;
```

Migration is module-by-module, starting with leaves (no cross-service deps) and working inward:

1. **Tier 0 modules** (no deps): `audit`, `webhooks`, `media`, `organization`. Convert first, no breakage.
2. **Tier 1 modules** (depend on tier 0): `customers`, `pricing`. Adopt `defineModule` syntax; declare deps explicitly.
3. **Tier 2 modules**: `catalog` (deps: pricing), `inventory` (deps: catalog).
4. **Tier 3 modules**: `cart` (deps: catalog, inventory), `orders` (deps: cart, inventory, payments, pricing, promotions).
5. **`createKernel` rewrite**: replace the manual 200-line wiring at `runtime/kernel.ts:218-346` with a topological-sort call against the module list. `Kernel["services"]` becomes `ServiceMap<TModules>`.

The `ServiceRegistry` interface at `kernel/service-registry.ts` is deleted (or kept as a deprecated alias) — the typed `defineModule` makes it redundant.

**Risks.**
- *Topological sort cycles*: a cycle (e.g., A depends on B, B depends on A) is a structural error. Mitigation: deliberately ordered tiers above; if a cycle surfaces, refactor — don't paper over.
- *Plugin services need module-shape too*: deferred to Sprint 5 along with framework extraction. For now, plugin services remain in `ctx.services` as `Record<string, unknown>` with a deprecation warning.
- *`Kernel` type breaking change*: any external consumer doing `kernel.services.catalog as CatalogServiceImpl` gets a type error. Acceptable for pre-1.0; document in CHANGELOG.

#### Stories

| Story | Description | DoD |
|-------|-------------|------|
| S4-01 | Create `kernel/module/define.ts` exporting `defineModule()`, `AppModule`, `ModuleDeps`, `ServiceMap` types. Pure type definitions + factory function. | Type tests (tsd or expectType) pass; no runtime behavior yet. |
| S4-02 | Convert tier-0 modules (audit, webhooks, media, organization) to `defineModule`. | All 4 services declared via `defineModule`; tier-0 tests green. |
| S4-03 | Convert tier-1 (customers, pricing). Declare deps. | Pricing reads `deps.services` typed, no inline casts. |
| S4-04 | Convert tier-2 (catalog, inventory). | Inventory reads catalog via typed deps; zero inline casts. |
| S4-05 | Convert tier-3 (cart, orders, fulfillment, promotions, search, shipping, tax, payments, analytics). | The 5 inline `as { adjust(...): ... }` casts in `orders/service.ts` are gone. |
| S4-06 | Rewrite `createKernel()` to assemble services via the module list with topological sort. Delete the manual wiring block. | `runtime/kernel.ts` is < 200 lines; all 247 existing tests green. |

**Demo:** Side-by-side diff: before (200-line manual wiring + 5 `as { ... }` casts) → after (`defineModule({ ... })` per module + zero inline casts). Plus IDE recording of `ctx.services.` autocomplete showing the typed service map.

**Dependencies:** Sprints 0–3 (foundation + multi-tenancy + bug fixes + docs honesty). The module system is invasive — it should land on a clean foundation.

**Source RFC §:** `FRAMEWORK-WIKI.md` §7 TD-002 + `FRAMEWORK-WIKI.md` §9 (Module System API design).

**Sprint-specific risks:**
- *Largest sprint by diff size*: 17 modules, every constructor changes. Detection: codex r2 will likely demand splitting into smaller PRs. Mitigation: each tier is its own atomic story; manager can break further if r1 calls for it.
- *Type-inference performance*: deeply generic `ServiceMap<TModules>` may slow `tsc` significantly. Detection: typecheck duration > 30s. Mitigation: profile with `tsc --extendedDiagnostics`; consider explicit type annotations at module boundaries.

**Exit criteria:** all 17 modules use `defineModule`; zero inline `Record<string, unknown>` casts in service code; WARMDOWN; HANDOFF.

---

### Sprint 5 — Typed Hooks + Framework Extraction

**Goal:** Replace `HookHandler = (...args: never[]) => unknown` with a typed hook map, fix `getMCPActor`, and move the 30 framework-clean files into `packages/framework`.

#### RFC-S5 — The hook system can't survive publication, and the framework boundary needs to exist as code

**Problem.** Three remaining structural debts before any external framework conversation: (TD-003) `HookHandler = (...args: never[]) => unknown` at `kernel/hooks/registry.ts:1` is the most embarrassing type in the codebase — every hook registration casts to `as HookHandler`, every resolution casts back to `as BeforeHook<X>[]`. Plugin authors writing hooks against the framework get zero IDE autocomplete and zero compile-time validation; (TD-Final) `getMCPActor()` returns hardcoded `userId: "mcp-agent"` with `organizationId: DEFAULT_ORG_ID`. In multi-tenant deployments every MCP tool call runs as the default org. RFC-040 deferred this; it cannot be deferred further; (boundary): the framework primitives are 80% identifiable but live mixed with domain code under `packages/core`. There's no code-level boundary between "framework" and "commerce" — only a conceptual one.

**Goal.** After this sprint: (1) hooks are typed end-to-end via a `CommerceHookMap` declaration. Plugin authors writing `hooks.append("catalog.afterCreate", "after", h)` get full type inference of `h`'s signature. (2) `getMCPActor()` derives identity from the connecting MCP session's auth context, with a documented fallback for unauthenticated MCP clients (gated on env var). (3) `packages/framework` exists as a workspace package, contains the 30 framework-clean files, and `packages/core` re-exports them (no breaking changes to consumers).

**Non-goals.** Publishing `@aeronyx/framework` to npm (premature per `FRAMEWORK-WIKI-PHASE-2.md` §7 — wait for second app + production customer + co-maintainer). Renaming `Commerce*Error` → `App*Error` (defer; backward-compat aliases would suffice but add noise). Implementing plugin service registration in `kernel.services` (deferred — current `ctx.services` is sufficient post-Sprint-4).

**Approach.**

**TD-003 — typed hook map**:

```typescript
// packages/framework/src/hooks/types.ts (new file post-extraction)
type CommerceHookMap = {
  "catalog.beforeCreate": { before: BeforeHook<CreateEntityInput> };
  "catalog.afterCreate":  { after: AfterHook<SellableEntity> };
  "orders.afterStatusChange": { after: AfterHook<OrderStatusChangeEvent> };
  // ... ~40 hooks total
};

class TypedHookRegistry<THooks extends Record<string, unknown>> {
  append<K extends keyof THooks & string>(
    key: K, phase: "before" | "after", handler: ...
  ): void;
}
```

Migration: ship the typed registry alongside the existing one (with `HookRegistry` as a deprecated alias). Convert hook registrations module-by-module. Existing untyped `(...args: unknown[])` handlers continue to work via an escape-hatch overload.

**`getMCPActor` fix**:

Read the actor from the MCP transport's connection context. The `WebStandardStreamableHTTPServerTransport` carries the original HTTP request — the auth middleware has already populated `c.var.actor`. Plumb it through. For unauthenticated MCP clients (allowed when `MCP_ALLOW_ANONYMOUS=true`), return a typed anonymous actor with explicit org from a header (`x-mcp-org-id`) or fail closed in strict mode.

**Framework extraction (the Phase 1 plan from `FRAMEWORK-WIKI.md` §11)**:

Create `packages/framework`. Move the 30 files identified in §8 of `FRAMEWORK-WIKI.md`:

- `kernel/hooks/` (entire dir)
- `kernel/result.ts`
- `kernel/errors.ts` (keep `Commerce*Error` aliases for now)
- `kernel/database/adapter.ts`, `tx-context.ts`
- `kernel/jobs/adapter.ts`, `types.ts`
- `kernel/compensation/`
- `kernel/state-machine/machine.ts` (generic FSM only — not `orderStateMachine`)
- `kernel/factory/repository-factory.ts`
- `kernel/query/`
- `kernel/service-timing.ts`
- `kernel/local-api.ts`
- `kernel/module/define.ts` (from Sprint 4)
- `auth/permissions.ts`, `access.ts`
- `utils/pagination.ts`
- `runtime/logger.ts`, `shutdown.ts`
- `test-utils/` (entire dir)

`@unifiedcommerce/core` re-exports everything. Zero breaking changes for external consumers. Internal imports update to point at the new package paths.

**Risks.**
- *Typed hook map is the hardest TypeScript work in the entire 6-week plan*: conditional inference across 40 hooks. Mitigation: ship in stages — start with the 5 most-used hooks; add type safety for the rest as a layered enhancement.
- *Framework extraction breaks bundler resolution*: workspace re-exports work locally but tooling like Vercel can mis-resolve. Mitigation: test against an actual deployment in the demo.
- *MCP anonymous fallback is itself a multi-tenancy hazard*: if `MCP_ALLOW_ANONYMOUS=true` becomes the default for ergonomic reasons, we recreate MT-1. Mitigation: default `false`; require explicit opt-in; pi gate must verify defaults.

#### Stories

| Story | Description | DoD |
|-------|-------------|------|
| S5-01 | Define `CommerceHookMap` type covering all ~40 hook keys. Define `TypedHookRegistry<THooks>` class. Keep existing `HookRegistry` as a deprecated alias re-exporting the typed version with `any`-bound generics. | Type tests pass; no runtime change yet. |
| S5-02 | Convert hook registrations in `runtime/kernel.ts` (`registerConfiguredHooks`) to the typed API. Verify autocomplete works. | All system hook registrations are typed; zero `as HookHandler` casts in core. |
| S5-03 | Convert plugin manifest hook registration (`kernel/plugin/manifest.ts:148-154`) to use the typed API. Provide an escape-hatch for plugins that legitimately want untyped handlers. | Gift-cards plugin's hooks are typed end-to-end; IDE autocomplete confirms. |
| S5-04 | Fix `getMCPActor()`: derive actor from MCP transport's connection context. Add `MCP_ALLOW_ANONYMOUS` env (default `false`) for anonymous fallback. | Test: authenticated MCP client → real actor; unauthenticated + strict → 401; unauthenticated + anonymous → typed anonymous actor with header-supplied org. |
| S5-05 | Create `packages/framework` workspace package. Move the 30 framework-clean files. Update internal imports. `packages/core` re-exports everything. | All 247 tests green; `package.json` workspaces config updated; consumer code unchanged. |
| S5-06 | Add minimal `packages/framework/README.md` documenting it as **internal only**, not yet for external consumption. Reference `FRAMEWORK-WIKI-PHASE-2.md` §7 for the publication preconditions. | README exists; explicitly states internal-use status; CI builds & publishes the package alongside core (workspace-private for now). |

**Demo:** Recorded session showing: (1) IDE autocomplete on `hooks.append("catalog.afterCreate", "after", (ctx) => /* ctx is fully typed */)`; (2) `getMCPActor` returning the connecting client's real actor (authenticated test) and rejecting an anonymous request when strict; (3) `tree packages/framework/src/` showing the extracted 30 files; (4) `bun run typecheck && bun run test` green across the monorepo.

**Dependencies:** Sprints 0–4 (foundation correctness + multi-tenancy + bugs fixed + docs honest + module system in place).

**Source RFC §:** `FRAMEWORK-WIKI.md` §7 TD-003 + `FRAMEWORK-WIKI.md` §9 (Typed Hook System) + `FRAMEWORK-WIKI.md` §11 Phase 1 + `FRAMEWORK-WIKI-PHASE-2.md` §10 Tier 5.

**Sprint-specific risks:**
- *Conditional generic inference scope*: 40 hooks may be too many to type all at once. Mitigation: brief budgets typing for the 10 most-used; the rest fall back to a typed-but-loose `(...args: unknown[]) => unknown` signature.
- *Framework extraction surfaces unknown internal imports*: a file we thought was framework-clean turns out to import from `modules/`. Detection: TypeScript build fails. Mitigation: pre-flight script in S5-05 brief that lists all imports from each candidate file before the move.

**Exit criteria:** all 6 stories Done; `packages/framework` exists; typed hooks work end-to-end; `getMCPActor` is honest; WARMDOWN with explicit "publication preconditions still not met" note; HANDOFF for any post-6-week followup.

---

## 4. Backlog (deferred to v1.x or v2)

| ID | Item | Earliest | Source RFC § |
|----|------|----------|--------------|
| B-01 | OpenTelemetry distributed tracing | post-6-week | `FRAMEWORK-WIKI-PHASE-2.md` §6 (Observability gaps) |
| B-02 | Webhook payload idempotency keys (event UUID) for receiver-side dedupe | post-6-week | `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-5 |
| B-03 | Plugin service registration into `kernel.services` (real fix for LB-2) | Sprint 6+ | `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-2 |
| B-04 | Plugin uninstall lifecycle hook + table cleanup story | post-extraction | `FRAMEWORK-WIKI.md` Phase 2.1 §7.4 |
| B-05 | Row-level security via `pgPolicy` for defense-in-depth | post-extraction | `FRAMEWORK-WIKI-PHASE-2.md` §3 MT-3 |
| B-06 | `unicore generate plugin` scaffolder | post-extraction | `FRAMEWORK-WIKI-PHASE-2.md` §8 |
| B-07 | `manifest.permissions` validation against `.permission()` calls in routes | post-Sprint-3 | `FRAMEWORK-WIKI-PHASE-2.md` §4 |
| B-08 | `extraColumns` plugin column extension (re-implement properly if demand exists) | v2 | `FRAMEWORK-WIKI-PHASE-2.md` §4 |
| B-09 | External publication of `@aeronyx/framework` (after preconditions met) | post-Sprint-5 | `FRAMEWORK-WIKI-PHASE-2.md` §7 |
| B-10 | Renaming `Commerce*Error` → `App*Error` with deprecation aliases | post-extraction | `FRAMEWORK-WIKI.md` §11 Phase 1 |
| B-11 | Hot-reload story for plugin development | post-extraction | `FRAMEWORK-WIKI-PHASE-2.md` §8 |
| B-12 | OpenAPI handler return-type unification (eliminate the 73 `@ts-expect-error` suppressions) | post-extraction | `FRAMEWORK-WIKI-PHASE-2.md` §8 |

---

## 5. Risks tracked across sprints

| Risk | Sprint(s) it materializes | Owner | Mitigation |
|------|---------------------------|-------|------------|
| Bus factor of 1 — sole maintainer cannot sustain both commerce engine + framework story | Sprint 5 onward | engineering manager | Slow down; defer external publication until co-maintainer or sponsor is in place (`FRAMEWORK-WIKI-PHASE-2.md` §9). |
| Concurrent migration deployment in production-sized DB | Sprint 0 (S0-03), Sprint 1 (S1-03) | manager + ops | Three-phase ALTERs; staging dry-run before production apply; back-off plan documented in WARMDOWN. |
| `STRICT_ORG_RESOLUTION` breaks existing single-store users | Sprint 1 | engineering manager | Default `true` for new installs only; `false` for existing; CHANGELOG migration guide. |
| Typed-hook generic inference compile-time cost | Sprint 5 (S5-01, S5-02) | manager + cursor IC | Profile typecheck; add explicit type annotations at boundaries if `tsc` exceeds 30s. |
| Workspace re-export resolution issues in deploy targets (Vercel, Cloudflare) | Sprint 5 (S5-05) | manager | Test against actual deploy targets in S5 demo, not just local typecheck. |
| Latest-stable bumps exceed wiki pinning | every sprint | manager | Verify `bun pm view <pkg> version` in each sprint's planning; raise wiki amendment if a bump is required. |
| Plugin authors depend on documented-but-deleted features | Sprint 3 | manager | CHANGELOG entry per deletion; explicit reasoning; backlog item if real demand surfaces. |
| Reaper interferes with valid long-running jobs | Sprint 2 (S2-06) | manager | Configurable threshold; documented as "if you have legitimate >5min jobs, set `JOB_REAP_THRESHOLD_MS` higher". |
| Sprint 4 module-system migration breaks existing test infrastructure | Sprint 4 | manager + cursor | Convert module-by-module in tier order; each tier its own atomic story; if tests fail mid-tier, halt and reassess. |
| Sprint 5 framework-extraction reveals hidden imports we missed | Sprint 5 (S5-05) | manager | Pre-flight script in brief enumerates all imports of candidate files; surfaces gotchas before move. |

---

## 6. The role of this document

This WBS is the *plan*, not the *prompt*. The prompt that any new session uses to advance the project one sprint lives at [`./SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md). The current sprint pointer lives at [`./STATE.md`](./STATE.md). Templates for the per-sprint artifacts live under [`./templates/`](./templates/).

When this WBS conflicts with the source wikis (`FRAMEWORK-WIKI.md`, `FRAMEWORK-WIKI-PHASE-2.md`), **the wikis win** — amend this document in the same PR.

The two source wikis are themselves living documents. Any sprint that produces a finding requiring an amendment to either wiki must land that amendment in the same sprint as the code change.
