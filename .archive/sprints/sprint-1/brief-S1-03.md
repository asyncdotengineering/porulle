# Story Brief — `S1-03` Add `organization_id` to inventory tables

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S1-03] inventory_levels + inventory_movements add organization_id`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s1-03-inventory-org-id.done`.

---

## 1. Goal

Add `organization_id` (NOT NULL, FK) to `inventory_levels` and `inventory_movements` so cross-tenant isolation no longer depends on the indirect `warehouse → organization` join chain (MT-3).

**Schema change only this story.** S1-04 wires the repository to use the new column.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs full validation at end of Sprint 4.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §3 MT-3.
2. `packages/core/src/modules/inventory/schema.ts` — full file. Note `inventory_levels` and `inventory_movements` lack `organization_id`. `warehouses` HAS it (FK to `organization`).
3. `packages/core/src/auth/auth-schema.ts` — `organization` table for the FK reference.
4. `RFC-002-POSTGRESQL-FIRST.md` — the project uses `drizzle-kit push`; schema additions are pushed, not migrated via files.
5. `apps/store-example/drizzle.config.ts` — for context on push targets.

---

## 3. Files to modify

**Modify:**
- `packages/core/src/modules/inventory/schema.ts` — add `organization_id text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" })` to BOTH `inventory_levels` and `inventory_movements`. Add an index on `organizationId` for both tables.

**Create (data backfill — this is a `drizzle-kit push`-friendly project, so no SQL files; ship a runner):**
- `packages/db/scripts/backfill-inventory-org-id.ts` — Node/Bun script:
  - For every `inventory_levels` row: `SET organization_id = (SELECT organization_id FROM warehouses WHERE warehouses.id = inventory_levels.warehouse_id)`.
  - Same for `inventory_movements`.
  - Idempotent — re-running is a no-op (rows already populated).
  - If a row references a missing/dangling warehouse, log a warning naming the row id and assign to `DEFAULT_ORG_ID` (literally the deprecated string) so the migration can proceed; operator follows up.

**Test:**
- Add to `packages/core/test/inventory-schema.test.ts` (create file if absent): assert that after schema push, both tables HAVE the `organization_id` NOT NULL column. Use `pg_columns` introspection query.

**Do not touch:**
- The repository (`repository/index.ts`) — that's S1-04.
- The service — also S1-04.

---

## 4. Operator runbook (write into commit body)

For production deploys, the manager will run:

```bash
# 1. Apply the schema change. The new column lands as NULL temporarily — see below.
DATABASE_URL=... bunx drizzle-kit push

# 2. Backfill before promoting NOT NULL would fail. We need a two-phase migration.
```

**Two-phase consideration:** drizzle-kit `push` will try to apply NOT NULL directly. On a non-empty `inventory_levels` table, this fails. The pragmatic move:

1. **First push:** add the column as nullable (DO NOT add `.notNull()` yet). Push.
2. **Backfill:** run `backfill-inventory-org-id.ts`.
3. **Second push:** make the column NOT NULL.

For this story: ship the schema with `.notNull()` (clean target state) but **document in the commit body the two-phase deploy procedure** for non-empty databases. Tests use empty PGlite DBs so the single-phase NOT NULL push works there.

---

## 5. Acceptance criteria

1. Both tables have `organization_id text NOT NULL` referencing `organization.id` with `onDelete: cascade`.
2. Indexes `idx_inventory_levels_org` and `idx_inventory_movements_org` exist.
3. `backfill-inventory-org-id.ts` is idempotent and handles missing warehouses gracefully (log + fallback).
4. Schema test asserts column presence post-push.
5. Commit body includes the two-phase operator runbook for non-empty databases.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S1-03] inventory_levels + inventory_movements add organization_id`.
- [ ] Sentinel `.handoff/result-s1-03-inventory-org-id.done`.

---

## 7. What NOT to do

- Do NOT modify the repository in this story — pure schema + backfill.
- Do NOT add CHECK constraints in this story (defer; the FK + repo enforcement in S1-04 is sufficient).
- Do NOT couple this to S1-04 — they ship as separate commits.
