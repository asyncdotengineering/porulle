# Story Brief — `S3-01` Delete `extraColumns` dead infrastructure

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-01] delete extraColumns dead infra`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-01-extra-columns-delete.done`.

---

## 1. Goal

Delete `mergeExtraColumns` / `ExtraColumnsOption` and the `PaymentAdapter.extraColumns?()` interface field. They are documented as features but called nowhere in core or plugins (FRAMEWORK-WIKI-PHASE-2 §4).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §4 (Dead Infrastructure).
2. `packages/core/src/kernel/schema/extra-columns.ts` — full file.
3. `packages/core/src/modules/payments/adapter.ts` line 46 — `extraColumns?(): Record<string, unknown>`.
4. Confirm there are zero callers: `grep -rn "mergeExtraColumns\|ExtraColumnsOption\|extraColumns" packages/core/src packages/plugins packages/adapters` — only definitions, no invocations. List your grep results in the commit body.

---

## 3. Files to modify

**Delete:**
- `packages/core/src/kernel/schema/extra-columns.ts` (entire file).

**Modify:**
- `packages/core/src/modules/payments/adapter.ts` — remove the `extraColumns?()` field from the `PaymentAdapter` interface.
- Any `index.ts` barrel that re-exports from `extra-columns.ts` — remove the re-export.
- `CHANGELOG.md` (if exists, otherwise `sprints/sprint-3/artifacts/S3-01-changelog.md`) — add an entry: "Removed unused `mergeExtraColumns` / `ExtraColumnsOption` / `PaymentAdapter.extraColumns` — never wired up. If you depended on these, raise an issue."

**Do not touch:**
- Any actual schema definitions or `pgTable` calls.
- `kernel/schema/` — except for the deletion.
- Tests (any test referencing extra-columns should fail to compile post-deletion; that's the signal manager catches at the gate).

---

## 4. Acceptance criteria

1. `extra-columns.ts` is deleted.
2. `PaymentAdapter.extraColumns?()` is removed.
3. Barrel re-exports updated.
4. Grep verification (in commit body): `grep -rn "mergeExtraColumns\|ExtraColumnsOption" packages/core/src packages/plugins packages/adapters` returns nothing post-change.
5. CHANGELOG entry written.

---

## 5. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-01] delete extraColumns dead infra`.
- [ ] Sentinel `.handoff/result-s3-01-extra-columns-delete.done`.

---

## 6. What NOT to do

- Do NOT preserve `extraColumns` as deprecated — fully delete. The whole point is to stop the docs from lying.
- Do NOT modify any schema columns.
- Do NOT introduce a replacement mechanism in this story (backlog B-08 covers a future re-implementation).
