# Story Brief — `S3-05` Dedupe `customerPermissions`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-05] dedupe customerPermissions read`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-05-customer-permissions.done`.

---

## 1. Goal

`auth/middleware.ts` reads `config.auth?.customerPermissions ?? [...defaults]` at line 18 AND line 197 (different code paths, same fallback hardcoded twice). Drift hazard. Dedupe.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §4.
2. `packages/core/src/auth/middleware.ts` — full file. Lines 18 and 197 both have the identical `config.auth?.customerPermissions ?? [...]` fallback.

---

## 3. Approach

Extract the default list to a single module-level `const DEFAULT_CUSTOMER_PERMISSIONS = [...]`. Both call sites read from this constant. Or better: extract a helper `getCustomerPermissions(config): string[]` that does the `?? DEFAULT_CUSTOMER_PERMISSIONS` once.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/auth/middleware.ts` — extract constant + helper, replace both sites.

**Create:**
- `packages/core/test/auth-customer-permissions-dedupe.test.ts` — test that overriding `config.auth.customerPermissions` in a test config affects BOTH code paths (the API key block and the storeResolver fallback).

---

## 5. Acceptance criteria

1. The hardcoded permissions list appears exactly ONCE in `middleware.ts`.
2. Both call sites read from the same source.
3. Override via config takes effect for both paths.
4. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-05] dedupe customerPermissions read`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT change the default permissions list itself.
- Do NOT export the constant publicly — keep it module-private.
