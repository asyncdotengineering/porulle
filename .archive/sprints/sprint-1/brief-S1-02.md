# Story Brief — `S1-02` `resolveOrgId` strict mode

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S1-02] resolveOrgId strict mode`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s1-02-resolve-org-strict.done`.

---

## 1. Goal

Add a strict-mode opt-in to `resolveOrgId` so that null-actor + no-default chains throw `OrgResolutionError` instead of silently returning the deprecated `"org_default"` literal (MT-2).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs full validation at end of Sprint 4.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §3 MT-2.
2. `packages/core/src/auth/org.ts` — full file. Note the four-level fallback chain in `resolveOrgId()`.
3. `packages/core/src/kernel/errors.ts` — error class hierarchy. Find or extend a `CommerceValidationError` / similar — DO NOT create a parallel error type.
4. The S1-01 commit (just landed) — the `STRICT_ORG_RESOLUTION` env var is already defined there. Reuse the same env var.
5. Search the codebase for callers of `resolveOrgId`: `grep -rn "resolveOrgId(" packages/core/src` and `grep -rn "resolveOrgId(" packages/plugins`. Document how many call sites would error in strict mode.

---

## 3. Files to modify

**Modify:**
- `packages/core/src/auth/org.ts` — add `OrgResolutionError` (extends existing CommerceError if there's a base class; otherwise create a minimal class). Modify `resolveOrgId(actor, defaultOrgId?)` body: check strict mode (config-then-env, same helper as S1-01); when strict + no actor + no defaults available → throw `OrgResolutionError`. When NOT strict → existing fallback chain (actor → defaultOrgId → _bootDefaultOrgId → "org_default").

**Create:**
- `packages/core/test/auth-resolve-org-strict.test.ts` — covers:
  - Actor with org → returns org (both modes).
  - No actor + explicit defaultOrgId param → returns param (both modes).
  - No actor + boot default set → returns boot default (both modes).
  - No actor + nothing set + strict mode → throws `OrgResolutionError`.
  - No actor + nothing set + legacy mode → returns `"org_default"` (with deprecation log).

**Do not touch:**
- `auth/middleware.ts` — that was S1-01.
- Any caller of `resolveOrgId` — they keep their current call shape; the throw happens conditionally inside.

---

## 4. Acceptance criteria

1. `OrgResolutionError` exists and extends the project's base error class (find it; do NOT invent a parallel hierarchy).
2. `resolveOrgId` reads strict mode the same way S1-01 does. Single helper if possible: extract `isStrictOrgResolution(config)` to a shared util that both `middleware.ts` and `org.ts` import.
3. Strict mode throws on the deprecated fallback path; legacy mode preserves the existing behavior.
4. Deprecation log fires (warn level, rate-limited if cheap to add) when legacy mode falls through to `"org_default"`.
5. Test covers all five scenarios in §3.
6. No `as any`, no public-surface drift beyond the new error class export.

---

## 5. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S1-02] resolveOrgId strict mode`.
- [ ] Sentinel `.handoff/result-s1-02-resolve-org-strict.done`.

---

## 6. What NOT to do

- Do NOT change `_bootDefaultOrgId`'s mutable global state — that's a separate debt (TD-007). Future sprint.
- Do NOT remove `DEFAULT_ORG_ID` even though it's deprecated. Some test fixtures use it.
- Do NOT make strict mode the default (consistent with S1-01).
