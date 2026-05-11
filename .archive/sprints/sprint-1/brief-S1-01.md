# Story Brief — `S1-01` `storeResolver` fail-closed

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S1-01] storeResolver fails closed`. **Sentinel mandatory:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s1-01-store-resolver.done` (or `STUCK <reason>`).

---

## 1. Goal

Replace the empty `catch {}` in the `storeResolver` path with explicit failure semantics so that a `storeResolver` exception cannot silently route a request to `org_default` (cross-tenant data leak vector MT-1).

---

## 1.5 Validation policy (sprint-wide)

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs full validation at end of Sprint 4. Your DoD: write the code + tests, stage, commit atomically, sentinel.

---

## 2. Required reading

1. `sprints/sprint-1/PLAN.md` (this directory) — sprint plan.
2. `FRAMEWORK-WIKI-PHASE-2.md` §3 MT-1 — root cause (empty `catch {}` at `auth/middleware.ts:179-204`).
3. `packages/core/src/auth/middleware.ts` — full file. The `storeResolver` block sits inside the `if (!c.get("actor"))` branch.
4. `packages/core/src/config/types.ts` — `AuthConfig.storeResolver` signature.
5. `packages/core/src/auth/types.ts` — `Actor` type.

---

## 3. Files to modify

**Modify:**
- `packages/core/src/auth/middleware.ts` — replace the inner empty `catch { /* fall through */ }` with strict-mode-aware handling.
- `packages/core/src/config/types.ts` — add `AuthConfig.strictOrgResolution?: boolean` (optional, default behavior described below).

**Create:**
- `packages/core/test/auth-store-resolver-strict.test.ts` — integration test:
  - With `strictOrgResolution: true` and `storeResolver` that throws → request returns 503.
  - With `strictOrgResolution: false` (or unset) AND env `STRICT_ORG_RESOLUTION=true` → 503.
  - With `strictOrgResolution: false` (or unset) AND no env override → legacy fallback (no actor, request continues with `actor = null`). Document that this is the legacy path.

**Do not touch:**
- `auth/org.ts` — that's S1-02.
- Any other module.

---

## 4. Behavior spec

```
Strict mode active when:
  config.auth?.strictOrgResolution === true
  OR process.env.STRICT_ORG_RESOLUTION === "true"

When storeResolver throws AND strict mode:
  - Log error with actor context
  - Return 503 Service Unavailable with body { error: { code: "ORG_RESOLUTION_FAILED", message: "..." } }
  - Do NOT call next()

When storeResolver throws AND legacy mode (default for backwards compat):
  - Log warning (NOT error) once per minute (rate-limited to avoid log flood)
  - Fall through (existing behavior — actor stays null)
```

The 503 needs to come from a `c.json({ error }, 503)` return. Wrap the existing middleware function so the early-return is honored.

---

## 5. Acceptance criteria

1. `AuthConfig.strictOrgResolution?: boolean` added to types.
2. `auth/middleware.ts` has a `isStrictOrgResolution(config)` helper that reads config + env.
3. `storeResolver` throws + strict mode → 503; assertion text mentions `ORG_RESOLUTION_FAILED`.
4. `storeResolver` throws + legacy mode → request continues with `actor = null` (verify by hitting a public endpoint that requires no auth).
5. Test `auth-store-resolver-strict.test.ts` covers all three cases above.
6. No `as any`, no `@ts-ignore`. Single atomic commit.

---

## 6. DoD

- [ ] All AC met.
- [ ] No public-surface drift beyond adding the optional `strictOrgResolution` config field.
- [ ] Atomic commit `[S1-01] storeResolver fails closed`.
- [ ] Sentinel `.handoff/result-s1-01-store-resolver.done`.

---

## 7. What NOT to do

- Do NOT make `strictOrgResolution: true` the default in this story — that'd be a breaking change for existing single-store deployments. Default is `false` (legacy fallback). New installs may set it to `true` in their config.
- Do NOT modify `resolveOrgId()` — that's S1-02.
- Do NOT run the full test suite per the sprint validation policy.
