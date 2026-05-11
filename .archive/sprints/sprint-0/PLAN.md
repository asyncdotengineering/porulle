# Sprint 0 — Plan

**Sprint name:** Foundation Hygiene + Critical Correctness
**Sprint goal (one sentence):** License the project, fix three silent data-corruption bugs (inventory lost-update, order-number race, compensation-failure-without-remediation), and make the starter template boot.
**Sprint window:** Week 1 of the 5-sprint repair plan
**Author (main session):** Claude Sonnet 4.6 — manager role per `sprints/SESSION_KICKOFF_PROMPT.md`
**IC worker:** `claude-glm` (overrides default cursor for this run)
**Review cadence:** Phase B deferred to after Sprint 4 (single consolidated review gate)

---

## 1. Stories

### `S0-01` — Add MIT LICENSE to repo root + every package.json

**Description:** Repo currently has no LICENSE file at root and no `"license"` field in `packages/core/package.json` or any other package. Un-licensed code is "all rights reserved" by default — Day 1 legal blocker. The only LICENSE in the tree is `apps/fashion-starter/LICENSE` (inherited from a Medusa fork; kept as-is since it's a fork).

**Acceptance criteria** (numbered, in priority order):
1. Standard MIT LICENSE file at repo root, copyright `2026 unified-commerce-engine contributors`.
2. Every one of the **35 package.json files** under `packages/*/package.json` and `packages/*/*/package.json` has `"license": "MIT"` in its top-level fields.
3. `apps/fashion-starter/LICENSE` is unchanged (inherited Medusa fork; out of scope).
4. `apps/*/package.json` files (5 apps) get `"license": "MIT"` too if they don't already.

**Files expected to be created or modified:**
- Create: `LICENSE` (repo root)
- Modify: 35 × `packages/*/package.json` and `packages/*/*/package.json` — add `"license": "MIT"` field
- Modify: 5 × `apps/*/package.json` — add `"license": "MIT"` field if missing

**Test fixtures:** None — this is a docs/config change. CI is green by inspection.

**Demo artifact:** `git diff --stat` showing 35+ modified package.json files + the new LICENSE file. Plus `find . -name 'package.json' -not -path './node_modules/*' -exec grep -L '"license"' {} +` returning empty.

---

### `S0-02` — Fix `inventory.adjust()` lost-update race

**Description:** `InventoryService.adjust()` at `packages/core/src/modules/inventory/service.ts:289-377` does read-modify-write without a row lock: `findLevelByKey(...)` → `updateLevel(id, { quantityOnHand: existing + adjustment })`. Two concurrent `adjust(+5)` calls both read `quantityOnHand=10`, both write `15` instead of `20`. Lost update. The `version` column exists on `inventory_levels` but `updateLevel` (`repository/index.ts:225-237`) doesn't check it in the `WHERE` clause.

**Acceptance criteria:**
1. `adjust()` uses `SELECT ... FOR UPDATE` on the level row inside an existing transaction (or opens one if absent) — same pattern as `reserveWithLock`.
2. New concurrency test in `packages/core/test/inventory-concurrency.test.ts` fires N parallel `adjust(+1)` calls and asserts final `quantityOnHand === starting + N`. Test currently fails on `main`; passes after fix.
3. The `version` column is incremented on every update (foundation for future OCC; not yet enforced in `WHERE`).
4. No change to public service signature.

**Files:**
- Modify: `packages/core/src/modules/inventory/service.ts` (`adjust` body)
- Modify: `packages/core/src/modules/inventory/repository/index.ts` (`updateLevel` increments `version`; new `findLevelForUpdate(key, ctx)` helper that does `SELECT FOR UPDATE`)
- Create: `packages/core/test/inventory-concurrency.test.ts`

**Demo artifact:** Test output showing the new concurrency test passing with N=50 parallel adjusts → final balance correct.

---

### `S0-03` — Replace `getNextOrderNumber()` with PostgreSQL sequence

**Description:** `getNextOrderNumber()` in `packages/core/src/modules/orders/repository/index.ts` does `SELECT COUNT(*) FROM orders WHERE EXTRACT(YEAR FROM created_at) = :year` and computes `count + 1`. Two concurrent inserts read the same count and produce **duplicate order numbers**.

**Acceptance criteria:**
1. New migration creates `order_number_seq` PostgreSQL sequence with `START WITH (SELECT COALESCE(MAX(numeric_part), 0) + 1 FROM orders)` (idempotent — script-driven).
2. `getNextOrderNumber()` body becomes `SELECT nextval('order_number_seq')` then formats with the year prefix.
3. Concurrency test fires 20 parallel order creations and asserts every order number is unique.
4. Backfill script `packages/db/scripts/backfill-order-seq.ts` is idempotent — re-running it with the sequence already at the right value is a no-op.

**Files:**
- Create migration: `packages/core/drizzle/00XX_order_number_sequence.sql` (or per existing migration convention — discover from repo)
- Modify: `packages/core/src/modules/orders/repository/index.ts` — `getNextOrderNumber()`
- Create: `packages/db/scripts/backfill-order-seq.ts`
- Create: `packages/core/test/order-number-concurrency.test.ts`

**Demo artifact:** Test output of 20 parallel `orders.create()` calls — every order number unique, monotonic.

---

### `S0-04` — Add `compensation_failures` table + repository

**Description:** When a compensation step fails (`runCompensationChain` at `packages/core/src/kernel/compensation/executor.ts:46-51`), the original error is returned but the compensation error is logged to stdout and abandoned. Customer charged + order cancelled with no remediation record. We need a persistent table.

**Acceptance criteria:**
1. New table `compensation_failures` with columns: `id (uuid pk)`, `organization_id (text)`, `correlation_id (text — links to order_id, request_id, job_id, etc.)`, `chain_name (text — e.g., 'checkout')`, `step_name (text)`, `original_error (jsonb)`, `compensation_error (jsonb)`, `occurred_at (timestamp)`, `resolved_at (timestamp nullable)`, `resolved_by (text nullable)`, `resolution_notes (text nullable)`.
2. Drizzle schema in `packages/core/src/kernel/compensation/schema.ts` — registered in `kernel/database/schema.ts` barrel export.
3. Repository `CompensationFailuresRepository` at `packages/core/src/kernel/compensation/repository.ts` with `record(input)`, `list({orgId, resolved?})`, `getById(id)`, `markResolved({id, resolvedBy, notes})` — returning `Result<T>`.
4. Migration applied via `drizzle-kit push` mechanism (this codebase uses push, not generate-and-apply migrations per RFC-002).
5. Tests for each repository method.

**Files:**
- Create: `packages/core/src/kernel/compensation/schema.ts`
- Create: `packages/core/src/kernel/compensation/repository.ts`
- Modify: `packages/core/src/kernel/database/schema.ts` (barrel export)
- Create: `packages/core/test/compensation-failures-repository.test.ts`

**Demo artifact:** Test output showing a `record() → list() → markResolved()` flow.

---

### `S0-05` — Wire `compensation_failures` into chain + admin routes

**Description:** Build on S0-04. When `runCompensationChain` catches a compensation error, persist a row. Add admin routes for operators.

**Acceptance criteria:**
1. `runCompensationChain` accepts an optional `failureRepository` and `correlationId`/`chainName` and persists every reverse-step failure.
2. `OrderService.checkout` (or wherever the chain is invoked) passes the repo + correlation id.
3. New admin routes:
   - `GET /api/admin/compensation-failures` — paginated list, filterable by `resolved=true|false`, `org` (admin scope only).
   - `POST /api/admin/compensation-failures/:id/resolve` — body `{ notes?: string }`, marks resolved with `resolvedBy = actor.userId`.
4. Permission scope: `compensation:admin` (added to `apiKeyScopes` definition; kernel registers it).
5. Forced-failure integration test: mock `inventory.release` to throw, run checkout, assert (a) original error returned, (b) row exists in `compensation_failures`, (c) `GET /api/admin/compensation-failures` returns the row.

**Files:**
- Modify: `packages/core/src/kernel/compensation/executor.ts`
- Modify: `packages/core/src/hooks/checkout-completion.ts`, `packages/core/src/hooks/checkout.ts`
- Create: `packages/core/src/interfaces/rest/routes/admin/compensation-failures.ts`
- Modify: `packages/core/src/interfaces/rest/routes/admin/index.ts` (register the route)
- Modify: `packages/core/src/runtime/kernel.ts` (instantiate `CompensationFailuresRepository`, expose on service container, scope permissions)
- Create: `packages/core/test/compensation-failures-integration.test.ts`

**Demo artifact:** Integration test recording — forced compensation failure → DB row → admin endpoint lists → resolve marks resolved.

---

### `S0-06` — Fix starter template + write `packages/core/README.md`

**Description:** The CLI starter template at `packages/cli/templates/starter/` ships unsupported `database: { provider: "sqlite" }` (engine only supports `postgresql`), is missing `drizzle.config.ts`, has no `.env.example`, and `packages/core/README.md` doesn't exist (npm install ships no docs).

**Acceptance criteria:**
1. `packages/cli/templates/starter/commerce.config.ts` uses `provider: "postgresql"` with adapter-postgres referenced.
2. `packages/cli/templates/starter/drizzle.config.ts` exists and references core + plugin schemas via `node_modules/@unifiedcommerce/...` glob (per `installation.mdx` correction).
3. `packages/cli/templates/starter/.env.example` exists with `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` documented.
4. `packages/cli/templates/starter/README.md` rewritten — accurate first-five-minutes flow (Postgres prereq, install, migrate, dev).
5. `packages/core/README.md` created — package install, basic config, link to `apps/docs`.
6. Manual smoke test: from a clean checkout, `bun install && cd packages/cli && bun run build && cd ../.. && node packages/cli/dist/index.js init /tmp/demo` produces a starter that can install + boot (assuming Postgres is running locally).

**Files:**
- Modify: `packages/cli/templates/starter/commerce.config.ts`
- Create: `packages/cli/templates/starter/drizzle.config.ts`
- Create: `packages/cli/templates/starter/.env.example`
- Modify: `packages/cli/templates/starter/README.md`
- Modify: `packages/cli/templates/starter/package.json` (deps include adapter-postgres)
- Create: `packages/core/README.md`

**Demo artifact:** Terminal log showing `init /tmp/demo && cd /tmp/demo && bun install && bun run dev` reaching "Server listening".

---

## 2. Universal DoD checklist (per story)

Copy this checklist into every story brief. The story is not closed until every box is ticked.

- [ ] CI green on Bun + Node 20 (project's supported runtimes).
- [ ] Behavioral coverage: every public surface tested with at least one happy-path and one failure-path test (where applicable to the story).
- [ ] Public TypeScript surfaces unchanged unless story explicitly amends them.
- [ ] No `--no-verify`, no `@ts-ignore`, no `try/except: pass`, no `as any`.
- [ ] Atomic commit with `[S0-{nn}] {title}`.
- [ ] Demo artifact captured under `sprints/sprint-0/artifacts/{story}.{ext}` or referenced in commit body.

---

## 3. Test plan

| Story | Layer | Test type | Fixtures |
|-------|-------|-----------|----------|
| S0-01 | n/a | manual lint check | grep for missing `"license"` |
| S0-02 | unit + integration | concurrency race test | PGlite test kernel |
| S0-03 | integration | concurrency uniqueness | PGlite + sequence migration |
| S0-04 | unit | repository CRUD | PGlite test kernel |
| S0-05 | integration | full checkout failure flow | PGlite + mocked inventory throwing |
| S0-06 | manual | smoke test | clean checkout boot |

What we will NOT test in this sprint:
- Production-scale migration (multi-million rows). Defer to staging dry-run before applying to prod.
- Multi-tenant compensation persistence behavior — that's Sprint 1's territory; S0-04/05 just need basic org-scoping.

---

## 4. Demo plan

Single combined recording at sprint warm-down: terminal session demonstrating S0-01 (LICENSE diff) → S0-02 (concurrent adjust passes) → S0-03 (concurrent orders unique) → S0-04/05 (forced compensation failure → DB row → admin resolve) → S0-06 (starter inits + boots).

---

## 5. Risks specific to this sprint

| Risk | Detection signal | Mitigation |
|------|------------------|------------|
| `SELECT FOR UPDATE` deadlocks under PGlite or pgbouncer transaction-mode | Test hangs > 30s | Use session-mode pool in tests; document prod-pool requirement in WARMDOWN |
| Order number sequence backfill picks wrong starting point | Duplicate order numbers right after migration | Backfill script reads `MAX(numeric_part)`; cursor must verify the regex matches existing format |
| `compensation_failures` schema needs `organization_id` from Sprint 1 | Foreign key fail | Sprint 0 stamps `organization_id = resolveOrgId(actor)` in S0-05; Sprint 1 makes it strict |
| Starter template fix breaks existing apps that use it | `apps/store-example` boot fails | Smoke-test the change against `apps/store-example` before commit |

---

## 6. Open questions

- **Q1**: The codebase uses `drizzle-kit push` (RFC-002) not generated migrations. For the `order_number_seq` (S0-03) and `compensation_failures` table (S0-04), do we ship raw SQL migration files or rely on push picking up schema changes?
  - **Decision (manager):** Add the schema in Drizzle (push picks it up automatically for the table); ship the **sequence** as a one-shot init SQL under `packages/db/scripts/init-sequences.sql` plus a `packages/db/scripts/migrate-sequences.ts` runner. Document in WARMDOWN.

- **Q2**: For S0-01, do we need `"license"` field in `packages/eslint-config` and `packages/typescript-config` (private workspace internals)?
  - **Decision (manager):** Yes. They're still package.json files; cost is zero, consistency wins.

- **Q3**: The fashion-starter LICENSE inherits from Medusa (Copyright 2022 Medusa). Do we re-license it under our MIT or leave as-is?
  - **Decision (manager):** Leave as-is for this sprint. Medusa's MIT is compatible. Re-attribution is a separate legal call deferred to backlog.

---

## 7. Execution order

S0-01 (cheapest, mechanical) → S0-02 (correctness) → S0-03 (correctness) → S0-04 (foundation for S0-05) → S0-05 (depends on S0-04) → S0-06 (independent, can fire parallel with S0-02/03/04 in principle but kept sequential for clarity).

S0-04 and S0-05 must be sequential — S0-05 imports the schema/repo from S0-04.
