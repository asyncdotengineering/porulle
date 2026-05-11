# Story Brief — `S3-03` Fix LocalAPI `commerce.api.giftCards` JSDoc

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-03] LocalAPI JSDoc reflects reality`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-03-localapi-jsdoc.done`.

---

## 1. Goal

The JSDoc at `packages/core/src/kernel/local-api.ts` documents `commerce.api.giftCards.checkBalance(...)` and `commerce.api.loyalty.redeemPoints(...)` — but plugin services never register into `kernel.services`, so these calls are `undefined` at runtime (LB-2). Delete the lying examples and add an accurate note.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-2.
2. `packages/core/src/kernel/local-api.ts` — full file. Find the JSDoc block at lines ~20-35 with the misleading examples.

---

## 3. Files to modify

**Modify:**
- `packages/core/src/kernel/local-api.ts` — JSDoc:
  - Remove `commerce.api.giftCards.checkBalance("CARD-CODE")` example.
  - Remove `commerce.api.loyalty.redeemPoints(...)` example.
  - Remove the line "Plugin services are automatically available".
  - Add: "Plugin services are NOT exposed on `commerce.api`. Plugins instantiate their own services inside `routes(ctx)` and `mcpTools(ctx)` via `ctx.services`. A future enhancement (backlog B-03) will introduce plugin service registration into the typed `kernel.services` map."

**Do not touch:**
- The local-api Proxy implementation itself (it's correct for what it actually does — only the docs lie).
- Any plugin source.

---

## 4. Acceptance criteria

1. JSDoc no longer claims plugin services are accessible via `commerce.api.<plugin>`.
2. JSDoc explains where plugin services actually live (`ctx.services` in route handlers).
3. References backlog B-03 for future fix.
4. No `as any`, no `@ts-ignore`.

---

## 5. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-03] LocalAPI JSDoc reflects reality`.
- [ ] Sentinel.

---

## 6. What NOT to do

- Do NOT implement plugin service registration in this story (backlog B-03; Sprint 4 module system territory).
- Do NOT remove the core service examples — `commerce.api.catalog.list()` still works and should stay.
