# Story Brief — `S0-03` Replace `getNextOrderNumber()` with PostgreSQL sequence

> **You are the IC engineer (`cursor` worker, fresh process for this story; clean context window).** Self-contained brief. If anything is ambiguous or contradicts what you find on disk, **stop and ask**. You are on branch `foundation-repair` — do NOT switch branches.
>
> **Atomic-commit policy:** when you finish, commit atomically with `[S0-03] order numbers via pg sequence`. No push, single commit.
>
> **Sentinel file (mandatory last step per `/ship-it` §7):** as your very last action: `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s0-03-order-seq.done`. If you couldn't finish: `echo "STUCK <one-line-reason>" > .handoff/result-s0-03-order-seq.done`.

---

## 1. Goal

Eliminate the order-number race condition (`SELECT COUNT(*) + 1` per `placed_at` year produces duplicates under concurrent inserts) by introducing a PostgreSQL sequence as the source of monotonicity, plus a backfill script that aligns the sequence with existing data.

---

## 1.5 Validation policy (sprint-wide — applies to every story 0–4)

**Do NOT run `bun run test`, `bun run check-types`, or `bun run lint` as part of your DoD.** The manager runs the full validation chain in the consolidated review gate at the end of Sprint 4. Your DoD is: write the code, write the tests (the manager will run them), stage, commit atomically, write the sentinel.

If your code is obviously broken at the file level (syntax error, missing import that you wrote yourself, type mismatch you can see by inspection), fix it. Otherwise trust the gate. Don't burn 3+ minutes on a full suite per story when the gate at the end will catch any compound issue across all 5 sprints in one pass.

What you DO verify before committing:
- The files you intended to create/modify exist with the intended changes (`git status`, `git diff --stat`).
- Imports and exports look right by inspection.
- New tests assert behavior, not just existence (read what you wrote).
- No `as any`, no `@ts-ignore`, no `--no-verify`, no `try/except: pass`.

What you DO NOT do:
- Run `bun run test` on the full suite.
- Run `bun run check-types` (turbo across the workspace — slow).
- Run `bun run lint`.
- Run individual `vitest` commands except where you're convinced your single test file needs a sanity-check (and even then, only that one file, e.g., `bunx vitest run packages/core/test/<your-new-file>`).

---

## 2. Required reading

1. `sprints/STATE.md`, `sprints/sprint-0/PLAN.md` — find the section for S0-03.
2. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-7 — root cause.
3. `packages/core/src/modules/orders/repository/index.ts` — full file. The function to rewrite is `getNextOrderNumber()` at line 273.
4. `packages/core/src/modules/orders/schema.ts` — `orders` table definition. The `orderNumber` column is `text("order_number").notNull()` with a unique-per-org index.
5. `RFC-002-POSTGRESQL-FIRST.md` — context on why the project uses `drizzle-kit push` (no migration files in tree). New schema objects are added to Drizzle and pushed.
6. Drizzle `pgSequence` documentation: https://orm.drizzle.team/docs/sequences (use the API; trust v0.31 docs over your training data).
7. `packages/core/test/test-utils/` — find the existing test kernel + DB setup. PGlite supports sequences.

---

## 3. Behavior decision (by manager) — read before coding

The current format `ORD-YYYY-NNNNNN` resets the per-year sequence (1 → 6-digit-pad). A global PostgreSQL sequence does NOT reset per year. **The manager has decided: switch to a single global sequence; retain `YYYY` in the prefix as informational only.**

New format: `ORD-YYYY-NNNNNN` where `YYYY` is the year of insertion and `NNNNNN` is the global `nextval('order_number_seq')` zero-padded to 6 digits.

Effective behavior change:
- **Before:** `ORD-2026-000001` was always the first 2026 order; `ORD-2027-000001` was always the first 2027 order.
- **After:** `ORD-2026-000543` is the 543rd order ever created; `ORD-2027-000544` is the 544th. Year prefix is informational; sequence is monotonic global.

Rationale: atomicity is the priority for Sprint 0 correctness. Per-year visual reset is a cosmetic property worth losing for an atomic guarantee. This is documented in the commit body.

If you disagree with this trade-off after reading the schema and existing tests, **stop and write a `.handoff/blocked-s0-03-order-seq.md`** describing the alternative and why — do not silently invent a different design.

---

## 4. Files you will create or modify

**Create:**
- `packages/core/src/modules/orders/sequences.ts` — exports `orderNumberSeq` via `pgSequence("order_number_seq", { startWith: 1, increment: 1 })` from `drizzle-orm/pg-core`. Single export.
- `packages/db/scripts/backfill-order-seq.ts` — Node/Bun script. Reads `MAX(numeric_part)` from existing `orders.order_number` rows (parse the `NNNNNN` after the second `-`). Calls `SELECT setval('order_number_seq', :max + 1, false)`. Idempotent — re-running with the seq already advanced is a no-op (compare current value with target).
- `packages/core/test/order-number-concurrency.test.ts` — concurrency test. 20 parallel `OrderService.create({...})` calls (or the equivalent low-level path that exercises `getNextOrderNumber`). Asserts every order number unique. Asserts every number monotonic (parse the numeric part; the set of N numbers should equal `{start, start+1, ..., start+N-1}`).

**Modify:**
- `packages/core/src/modules/orders/repository/index.ts` — `getNextOrderNumber()` body becomes a single `SELECT nextval('order_number_seq')` plus year prefix formatting. Drop the `count(*)` query.
- `packages/core/src/kernel/database/schema.ts` — re-export the sequence from the orders module so `drizzle-kit push` picks it up. (Verify this is the existing convention by reading the file first.)

**Do not touch:**
- `orders` table column definitions.
- Any other `getNext*` or sequence-using code.
- Test fixture seed data (no need to change historical order numbers).
- `apps/store-example` or other consumers' configs.
- `sprints/`.

---

## 5. The fix (concrete approach)

Drizzle pg-core sequence pattern:
```typescript
// packages/core/src/modules/orders/sequences.ts
import { pgSequence } from "drizzle-orm/pg-core";

export const orderNumberSeq = pgSequence("order_number_seq", {
  startWith: 1,
  increment: 1,
});
```

Updated `getNextOrderNumber`:
```typescript
async getNextOrderNumber(ctx?: TxContext): Promise<string> {
  const year = new Date().getFullYear();
  const db = this.getDb(ctx);
  const result = await db.execute(sql`SELECT nextval('order_number_seq') AS seq`);
  const seq = (result as unknown as Array<{ seq: bigint | number | string }>)[0]?.seq;
  if (seq == null) {
    throw new Error("Failed to get next order number — sequence returned null");
  }
  const seqNum = typeof seq === "bigint" ? Number(seq) : Number(seq);
  return `ORD-${year}-${String(seqNum).padStart(6, "0")}`;
}
```

(The exact result-shape unwrap depends on Drizzle's `db.execute` return shape — verify against existing patterns in the codebase by grepping `db.execute(sql\``.)

Backfill script outline:
```typescript
// packages/db/scripts/backfill-order-seq.ts
import { sql } from "drizzle-orm";
import { db } from "..."; // wire up to local DB
async function main() {
  const rows = await db.execute(sql`
    SELECT COALESCE(
      MAX(CAST(SUBSTRING(order_number FROM '[0-9]+$') AS INTEGER)),
      0
    ) AS max_seq FROM orders
  `);
  const max = Number((rows as any)[0]?.max_seq ?? 0);
  const target = max + 1;
  // Idempotent: setval(..., is_called=false) means next nextval() returns target
  await db.execute(sql`SELECT setval('order_number_seq', ${target}, false)`);
  console.log(`order_number_seq aligned: next value = ${target}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

---

## 6. Acceptance criteria (numbered, in priority order)

1. `pgSequence("order_number_seq", { startWith: 1, increment: 1 })` is declared in Drizzle schema and discoverable by `drizzle-kit push` (verify by running push against PGlite in your test setup).
2. `getNextOrderNumber()` calls `nextval('order_number_seq')`. The `count(*)` query is gone.
3. `order-number-concurrency.test.ts` exists. 20 parallel order creations produce 20 unique, monotonic order numbers. Test currently fails on `main` (verify by stash); passes after fix.
4. `backfill-order-seq.ts` runs idempotently against a seeded DB with existing orders. Re-running advances the sequence to `MAX + 1` and a second run is a no-op.
5. `packages/core/test/test-utils/` is updated only if necessary to make the concurrency test work (e.g., to ensure the sequence is created in PGlite before the test runs). Do NOT change unrelated test infrastructure.
6. Manual verification (in commit body): `psql -c "SELECT nextval('order_number_seq')"` returns increasing values; `\ds` lists the sequence.
7. The format change (`ORD-YYYY-NNNNNN` with global N) means any existing test asserting "first order of 2026 is `ORD-2026-000001`" must be updated to assert format-pattern rather than exact value. **Update those tests in this commit** but do NOT run the full suite to find them — search by grep (`grep -rn "ORD-20" packages/core/test/`) and update the matches.

---

## 7. Definition of Done

- [ ] All acceptance criteria met (by inspection — manager runs the suite at the gate).
- [ ] No `as any`, no `@ts-ignore`, no `--no-verify`.
- [ ] Commit `[S0-03] order numbers via pg sequence` with body covering: (a) format-change rationale, (b) any test files updated to format-pattern assertion (list them), (c) the backfill command operators run pre-deploy.
- [ ] Sentinel: `.handoff/result-s0-03-order-seq.done` with `DONE <sha>` (or `STUCK <reason>`).

---

## 8. What NOT to do

- Do NOT introduce per-year sequences (`order_number_seq_2026`, etc.) — manager rejected this in §3.
- Do NOT ship raw SQL migration files. The project uses `drizzle-kit push`. The sequence goes in Drizzle.
- Do NOT silently rename the sequence — `order_number_seq` is the contracted name.
- Do NOT modify the `orders` table schema (columns, indexes).
- Do NOT push the commit.

---

## 9. If you get stuck

- If `drizzle-kit push` doesn't pick up the sequence: surface in `.handoff/blocked-s0-03-order-seq.md` with the actual `push --verbose` output. We may need to add the sequence to the schema barrel manually.
- If PGlite doesn't support `nextval`/`setval`: it should (PGlite 0.2+ has full PostgreSQL semantics for sequences). If it genuinely doesn't, document and STUCK.
- If the format change breaks more tests than expected: enumerate them and surface for manager review before patching them all.

You are the IC. Sincere work is the only kind we ship.
