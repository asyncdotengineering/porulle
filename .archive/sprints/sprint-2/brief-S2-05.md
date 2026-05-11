# Story Brief — `S2-05` URL alias inject-not-redispatch

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S2-05] URL aliases inject query param without re-dispatch`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s2-05-alias-inject.done`.

---

## 1. Goal

Fix LB-8: `runtime/server.ts:261-287` URL aliases (`/api/products` → `/api/catalog/entities?type=product`) are implemented by constructing a new `Request` and calling `app.fetch()`. This re-enters all middleware (CORS, CSRF, body limit, **all 3 rate limiters**, auth). Result: alias requests count twice against quota.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-8.
2. `packages/core/src/runtime/server.ts` lines 255–295 — current alias handling.
3. The catalog routes module — find where `/api/catalog/entities` is registered. Understand how `type` query param is handled today (existing endpoint already accepts a `type` param).

---

## 3. Approach

Replace `app.fetch(new Request(...))` with internal handler delegation:

**Option A (preferred):** rewrite the request URL in-place via Hono's `c.req.path`/query manipulation and call `next()` to chain to the canonical route handler. Hono supports this via `c.req.url` mutation but it's discouraged. Practical alternative:

**Option B (simpler):** the alias handlers register on the same paths as the catalog routes via a tiny middleware that mutates `c.req.query.type` then calls the catalog route handler directly (not through `app.fetch`).

Cleanest implementation:
- Import the catalog routes' handler functions directly.
- For each alias, register a Hono route on `/api/products`, `/api/categories`, etc., that calls the catalog route's handler with the `type` filter pre-applied.
- For sub-paths (`/api/products/:id`), do the same with the path-param mapped to the catalog endpoint.

This avoids the `app.fetch` re-entry entirely.

If extracting catalog handlers proves too invasive, fall back to **Option C**: keep `app.fetch` re-dispatch but inject a header `x-internal-alias-redispatch: 1`; the rate limiter, CSRF, and auth middleware all check for this header and skip if present. Document in the commit body.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/runtime/server.ts` lines 255–295 — replace re-dispatch.
- The middleware code that needs to skip on internal redispatch (rate limiter at minimum) IF you go with Option C.

**Create:**
- `packages/core/test/url-alias-no-double-rate-limit.test.ts`:
  - Configure rate limit to 5 req/sec.
  - Hit `/api/products` 5 times.
  - Assert: all 5 succeed (i.e., alias didn't double-count).
  - Hit a 6th time → 429.

**Do not touch:**
- The catalog routes' canonical paths.
- The rate limiter's external API (config shape).

---

## 5. Acceptance criteria

1. Alias request counts ONCE against rate limit quota (verified by test).
2. Alias still functionally maps to the canonical handler (no behavioral regression).
3. CSRF / body limit / auth middleware no longer fire twice per alias request.
4. No `as any`, no `@ts-ignore`. No public-surface drift.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S2-05] URL aliases inject query param without re-dispatch`.
- [ ] Sentinel `.handoff/result-s2-05-alias-inject.done`.

---

## 7. What NOT to do

- Do NOT remove the alias feature itself.
- Do NOT change the catalog handlers' logic.
- Do NOT introduce a separate alias-only rate-limit bucket — that addresses the symptom, not the cause.
