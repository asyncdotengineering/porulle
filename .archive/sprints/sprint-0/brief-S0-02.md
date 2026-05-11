# Story Brief — `S0-02` Fix `inventory.adjust()` lost-update race

> **You are the IC engineer (`claude-glm` worker, fresh process for this story; clean context window) with no prior context.** This brief is self-contained. Read it end-to-end before writing any code. If anything in this brief is ambiguous or contradicts what you find on disk, **stop and ask** rather than guess.
>
> **Atomic-commit policy:** when you finish, stage every file you create / modify and commit atomically with `[S0-02] inventory.adjust uses SELECT FOR UPDATE`. Do NOT push. Do NOT make multiple commits per story. Manager handles fix-pass and closeout commits later. **You are on branch `foundation-repair` — do NOT switch branches.**
>
> **Sentinel file (mandatory last step per `/ship-it` §7):** as your very last action before exiting, write `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s0-01-license.done`... wait, that's the previous slug. For this story write `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s0-02-inventory-adjust.done`. The manager's Monitor reads exactly this filename.

---

## 1. Goal

Fix the silent lost-update race in `InventoryService.adjust()` by routing it through the existing `findLevelForUpdate` row-lock path that `reserveWithLock` already uses, and add a concurrency test that proves the fix.

---

## 2. Required reading (in this order)

Read these files **in full** before touching code. They are the contract.

1. `sprints/STATE.md` — current sprint pointer.
2. `sprints/sprint-0/PLAN.md` — find the section for `S0-02`.
3. `sprints/WBS.md` § Sprint 0 (the RFC-S0 block).
4. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-4 — the bug description and root cause analysis.
5. `packages/core/src/modules/inventory/repository/index.ts` — full file. Pay attention to:
   - `findLevelForUpdate` (around line 290 — the `SELECT FOR UPDATE` helper that already exists)
   - `findLevelByKey` (line 144 — the unsafe read used today)
   - `updateLevel` (line 225 — does NOT increment `version` today)
   - `reserveWithLock` (line 381 — the **model pattern** for what we're applying to adjust)
   - `releaseWithLock` (line 429 — same pattern, mirror)
6. `packages/core/src/modules/inventory/service.ts` — full file. Pay attention to:
   - `adjust` (line 289 — the function to fix)
   - The pattern for hook context creation (line 359)
   - `reserve` and `release` higher up — they delegate to `reserveWithLock` already
7. `packages/core/src/kernel/database/tx-context.ts` — `TxContext`, `withTransaction`, `createTxContext` — to understand how to open a transaction when one isn't passed in.
8. The memory note at `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-rnd-venture-sell-unified-commerce-engine/memory/MEMORY.md` — particularly the "null vs undefined for variantId" rule. Drizzle returns `null` for nullable columns; never pass `null` to `eq()` — use `isNull()` or `!= null` guards.

---

## 3. Files you will create or modify

Be explicit. The reviewer will check that you didn't touch anything else.

**Modify:**
- `packages/core/src/modules/inventory/service.ts` — rewrite `adjust()` body to route through a row-locked path. Keep the public signature unchanged.
- `packages/core/src/modules/inventory/repository/index.ts` — modify `updateLevel` to increment `version` on every update (`version: existing.version + 1`). Optionally extract a small helper if it makes the diff cleaner; do not over-engineer.

**Create:**
- `packages/core/test/inventory-concurrency.test.ts` — concurrency test. Spawns N parallel `adjust(+1)` calls against the same `(entityId, variantId, warehouseId)` triple, asserts final `quantityOnHand === starting + N`.

**Do not touch:**
- The `version` column's `WHERE` clause enforcement — that's a future OCC story (backlog). For now we just **increment** version on update.
- `reserveWithLock`, `releaseWithLock`, `findLevelForUpdate` — these are the working models. **Do NOT modify them.**
- Any other module under `packages/core/src/modules/`.
- Any plugin under `packages/plugins/`.
- Any `package.json`, `drizzle.config.ts`, or migration files.
- The `sprints/` directory.

---

## 4. The fix (concrete approach)

Read `reserveWithLock` (`repository/index.ts:381`) carefully — it's the canonical pattern for "atomic read-modify-write under row lock":

```typescript
async reserveWithLock(entityId, variantId, warehouseId, quantity, ctx: TxContext) {
  const level = await this.findLevelForUpdate(entityId, variantId, warehouseId, ctx);
  if (!level) return { ok: false, reason: ... };
  // ... business logic ...
  const updated = await this.getDb(ctx)
    .update(inventoryLevels)
    .set({ ..., version: level.version + 1 })
    .where(eq(inventoryLevels.id, level.id))
    .returning();
  return { ok: true, level: updated[0]! };
}
```

`adjust()` today does the equivalent of:

```typescript
const existing = await this.repo.findLevelByKey(...);  // BAD: no row lock
const newQty = Math.max(0, existing.quantityOnHand + input.adjustment);
const updated = await this.repo.updateLevel(existing.id, { quantityOnHand: newQty }, ctx);  // BAD: no version check, no row lock
```

The fix has two halves:

**Half A — `service.ts` `adjust()`:** wrap the read+update pair in a transaction context. If the caller passed `ctx`, use it. Otherwise open one via `withTransaction(this.deps.database, async (txCtx) => { ... })`. Inside the transaction, call `findLevelForUpdate` (NOT `findLevelByKey`) for the existing-row case. If the row doesn't exist (new-level case), `createLevel` is fine — there's nothing to race with for a row that doesn't exist yet (the unique index on `(entityId, variantId, warehouseId, organizationId)` would force the second concurrent `createLevel` to fail; either both adjusts converge to the same row on retry, or one of them throws — acceptable because creating-then-adjusting is rare in practice. If you can preserve current behavior of "first-call creates, subsequent adjusts increment" while still being concurrency-safe, do so; otherwise, make a defensible decision and write it in your commit body).

**Half B — `repository/index.ts` `updateLevel`:** add `version: existingValue + 1` to the `set(...)` clause. The simplest way is to fetch the level first inside `updateLevel`, but that re-introduces the read-modify-write pattern at the repo level. Cleaner: have `updateLevel` accept an optional `expectedVersion` parameter and write `version: expectedVersion + 1` when provided; fall back to a SQL `version: sql\`${inventoryLevels.version} + 1\`` expression when not. **Pick the cleanest option that preserves all existing callers** — there are several callers of `updateLevel` outside `adjust` (search the file).

---

## 5. Acceptance criteria (numbered, in priority order)

1. `adjust()` uses `findLevelForUpdate` (or equivalent row-locked read) when an existing level row is being updated. The read+update pair lives inside a single transaction context — either the caller's `ctx` or one opened via `withTransaction`.
2. `updateLevel` increments `version` on every update. Existing callers continue to work without code changes (the increment is automatic via SQL expression OR the caller passes `expectedVersion` — your choice, document it in commit body).
3. `inventory-concurrency.test.ts` exists and:
   - Sets up an inventory level with `quantityOnHand: 100`.
   - Fires **50 parallel `inventory.adjust({ adjustment: 1, ... })` calls** via `Promise.all([...])`.
   - Asserts final `quantityOnHand === 150` (NOT 51, NOT some-value-less-than-150).
   - Asserts the final `version` is `151` or `100 + 50` (whatever the starting version + 50).
   - Test runs against PGlite via the existing test harness in `packages/core/test/test-utils/`.
4. The same test fails on `main` (you can verify by stashing your `service.ts` change and re-running) — record this in your commit body.
5. All existing inventory tests still pass (`bun run test --filter packages/core` or whatever the project's test command is — check `packages/core/package.json` scripts).
6. Public service signature of `adjust()` unchanged. Public repo signature of `updateLevel` either unchanged OR backwards-compatible (optional new parameter with default).
7. No `as any`, no `@ts-ignore`, no `--no-verify`.

---

## 6. Definition of Done (universal)

Every box must be ticked before you commit:

- [ ] All acceptance criteria met.
- [ ] `bun run test` passes (full suite green; not just inventory tests).
- [ ] `bun run check-types` passes.
- [ ] No public-surface changes.
- [ ] Atomic commit `[S0-02] inventory.adjust uses SELECT FOR UPDATE` with body summarizing: (a) what the bug was, (b) the fix mechanism, (c) confirmation the new test fails on `main` and passes after the fix, (d) any caller of `updateLevel` outside adjust that might be affected.
- [ ] Sentinel file written: `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s0-02-inventory-adjust.done`. (Or `echo "STUCK <reason>" > .handoff/result-s0-02-inventory-adjust.done` if you couldn't finish — name the reason.)

---

## 7. What NOT to do

- Do NOT modify `reserveWithLock`, `releaseWithLock`, or `findLevelForUpdate` — these are the working models. Reuse them.
- Do NOT add OCC retry-on-conflict logic — that's deliberately deferred. Just increment version; don't enforce it in WHERE yet.
- Do NOT silently ignore the no-existing-level branch — `createLevel` followed by an adjust is acceptable; race between two `createLevel` calls is acceptable to throw (it's a rare path); just don't *introduce* a worse race than today.
- Do NOT refactor `adjust()` beyond what the row-lock fix requires (e.g., don't extract a new helper unless it genuinely makes the fix cleaner).
- Do NOT write code that holds a transaction across HTTP boundaries or across the hook fan-out.
- Do NOT pass `null` to Drizzle's `eq()`. The MEMORY.md note is load-bearing — `null` to `eq(col, value)` produces `col = NULL` SQL which never matches. Use `!= null` guards or `isNull(col)`.
- Do NOT commit before the test you wrote actually fails on `main` — that's the proof the test is well-formed.
- Do NOT push.

---

## 8. Demo artifact

Capture the following in your commit body OR drop into `sprints/sprint-0/artifacts/S0-02-test-output.txt`:

1. Full test output of `inventory-concurrency.test.ts` running against the **fixed** code (passes).
2. Full test output of the same test against `main` (fails with `quantityOnHand` < 150). You can produce this by `git stash` of your `service.ts` change, running the test, then `git stash pop`.

---

## 9. How to report back

When you finish:

1. Print the commit sha and a one-line summary.
2. Print `git diff HEAD~1 --stat`.
3. Print the test output (passing case).
4. Note any caller of `updateLevel` outside `adjust` that needed adjusting.

---

## 10. If you get stuck

- If `findLevelForUpdate` doesn't behave as expected under PGlite (PGlite has historical quirks with `FOR UPDATE`): note it in your commit body and document the workaround. The kickoff prompt's risk register already names this as a known concern.
- If the test infrastructure doesn't support spawning 50 parallel transactions: drop to N=10 and document why.
- If `updateLevel` has callers that break under your version-increment change: enumerate them in the commit body. Do not silently change their behavior.
- If you need to `STUCK <reason>` the sentinel: write a `.handoff/blocked-s0-02-inventory-adjust.md` first with the full diagnostic, then write the STUCK sentinel referencing it.

You are the IC. Sincere work is the only kind we ship.
