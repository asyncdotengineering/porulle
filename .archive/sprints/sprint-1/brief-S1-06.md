# Story Brief — `S1-06` Jobs adapter requires `organizationId`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S1-06] DrizzleJobsAdapter.enqueue requires organizationId`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s1-06-jobs-org-required.done`.

---

## 1. Goal

Eliminate the silent `DEFAULT_ORG_ID` default in `DrizzleJobsAdapter.enqueue()` so callers cannot accidentally enqueue jobs to the wrong org (MT-5).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §3 MT-5.
2. `packages/core/src/kernel/jobs/drizzle-adapter.ts` — full file. The line of interest: `organizationId: options?.organizationId ?? DEFAULT_ORG_ID`.
3. `packages/core/src/kernel/jobs/adapter.ts` — `JobsAdapter` interface + `EnqueueOptions` type.
4. `packages/core/src/kernel/jobs/types.ts` — `TaskDefinition`, etc.
5. Search for every caller of `enqueue`: `grep -rn "\.enqueue(" packages/core/src packages/plugins/*/src` — list all in your commit body. They all need to pass `organizationId` explicitly.

---

## 3. Approach

`EnqueueOptions.organizationId` becomes **required**. This is a TypeScript breaking change for callers but caught at compile time. Update every caller.

```typescript
// Before:
interface EnqueueOptions {
  organizationId?: string;
  queue?: string;
  // ...
}

// After:
interface EnqueueOptions {
  organizationId: string;  // required
  queue?: string;
  // ...
}
```

Caller updates: every call site must compute `organizationId` from its actor or context. Inside service methods that have `actor`, use `resolveOrgId(actor)`. Inside hooks, use `ctx.actor` and `resolveOrgId`.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/kernel/jobs/adapter.ts` — `EnqueueOptions.organizationId` becomes required.
- `packages/core/src/kernel/jobs/drizzle-adapter.ts` — remove the `?? DEFAULT_ORG_ID` fallback. Add a runtime assertion as defense-in-depth: if `options.organizationId` is empty/null at runtime, throw `OrgResolutionError` (or whatever the project's tier-1 error is — check S1-02's commit).
- Every caller of `enqueue()` discovered via grep — update each to pass `organizationId` explicitly.

**Create:**
- `packages/core/test/jobs-adapter-org-required.test.ts` — test:
  - Calling `enqueue` with org id → row inserted with that org.
  - Calling `enqueue` without org id → TypeScript error at compile time (assert via tsd or by simply having the test file fail to compile if you remove the cast). At runtime, throws.

**Do not touch:**
- The `commerce_jobs` schema (no column changes).
- Job-runner internals (`runner.ts`).
- `DEFAULT_ORG_ID` in `auth/org.ts` (deprecated but kept for legacy fallbacks).

---

## 5. Acceptance criteria

1. `EnqueueOptions.organizationId` is required (no `?`).
2. `DrizzleJobsAdapter.enqueue()` throws if called with falsy `organizationId` at runtime.
3. Every internal caller of `enqueue` updated to pass `organizationId` explicitly. List them in commit body.
4. Test covers the happy path + the runtime-throw path.
5. No `as any`, no `@ts-ignore`. No `??DEFAULT_ORG_ID` anywhere in the adapter.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S1-06] DrizzleJobsAdapter.enqueue requires organizationId`.
- [ ] Sentinel `.handoff/result-s1-06-jobs-org-required.done`.

---

## 7. What NOT to do

- Do NOT add a wrapper that defaults from ambient request context — that hides the dependency. Explicit pass-through is the contract.
- Do NOT introduce a parallel `JobsAdapter.enqueueScoped(actor, ...)` API — keep the interface minimal.
- Do NOT remove `DEFAULT_ORG_ID` constant — it's still used in deprecated paths.
