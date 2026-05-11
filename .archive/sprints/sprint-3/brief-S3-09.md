# Story Brief — `S3-09` Auto-bootstrap on `bun run dev`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-09] dev mode auto-bootstrap DB`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-09-auto-bootstrap.done`.

---

## 1. Goal

Fresh DB + `bun run dev` should boot end-to-end without the developer needing to know about `db:push`. Detect missing core tables and run `drizzle-kit push` automatically when `NODE_ENV !== 'production'`. Eliminates the "first 5 minutes" papercut where new developers hit `relation "user" does not exist` (FRAMEWORK-WIKI-PHASE-2 §8).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §8.
2. `packages/cli/src/commands/dev.ts` — current dev command body.
3. `packages/cli/templates/starter/src/dev-server.ts` — starter template's dev entry.
4. `packages/cli/src/commands/migrate.ts` — find the existing `drizzle-kit push` invocation pattern.
5. Better Auth's `user` table — proxy for "auth schema pushed".

---

## 3. Approach

In `dev.ts` (or wherever `dev` boot is) — before starting the server:

1. If `NODE_ENV === 'production'` → skip auto-bootstrap (production must be explicit).
2. Else: connect to DB, run `SELECT 1 FROM "user" LIMIT 1`. If it errors with "relation does not exist":
   a. Console log: `⚠ Tables missing — running drizzle-kit push to bootstrap…`
   b. Spawn `drizzle-kit push --force` (or whatever the existing migrate command runs).
   c. Console log: `✓ Bootstrap complete. Starting dev server…`
3. Continue server boot.

If `drizzle-kit push` fails:
- Print the error.
- Print: "Try `bun run db:push` manually or check your DATABASE_URL."
- Exit non-zero.

---

## 4. Files to modify

**Modify:**
- `packages/cli/src/commands/dev.ts` — add the auto-bootstrap pre-flight.

**Create:**
- `packages/cli/test/dev-auto-bootstrap.test.ts` — test (against a fresh PGlite DB):
  - Boot with no tables → bootstrap fires → tables exist → server starts.
  - Boot with tables present → skip bootstrap → server starts directly.
  - `NODE_ENV=production` + no tables → bootstrap skipped (would fail, but we don't auto-fix in prod).

**Do not touch:**
- Production deployment paths.
- The migrate command (separate from dev).

---

## 5. Acceptance criteria

1. Fresh DB + `bun run dev` (NODE_ENV=development) → server boots after auto-bootstrap.
2. Tables already exist + `bun run dev` → no extra work, server boots directly.
3. `NODE_ENV=production` + missing tables → auto-bootstrap skipped, server fails with the original error (no silent magic in prod).
4. Bootstrap logs are informative + actionable on failure.
5. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-09] dev mode auto-bootstrap DB`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT auto-bootstrap in production.
- Do NOT auto-seed any data.
- Do NOT modify the schema or push logic itself; just invoke the existing `drizzle-kit push` flow.
- Do NOT prompt the user — bootstrap is silent (with logs) when in dev.
