# HANDOFF — foundation-repair branch (post Phase B)

**One page. Read this first.** Full WARMDOWN at `sprints/phase-b/WARMDOWN.md`.

---

## State of the world

Foundation repair is structurally **complete and fully validated**. 33 stories shipped across Sprints 0–4 + Phase B comprehensive fix-pass on the `foundation-repair` branch (39 commits). `main` is untouched at `09f36ba`. **All three validation gates pass:**

```
bun install:        ✅ clean
bun run check-types: ✅ 38/38 packages
bun run test:        ✅ 56/56 tasks
bun run lint:        ✅ 25/25 packages
```

The drizzle hash-drift issue (which previously affected plugin-wishlist) was resolved workspace-wide via a new `@unifiedcommerce/core/drizzle` re-export. All 13 plugins + 4 apps now import drizzle through core, eliminating the variant problem.

The user's pre-Phase-A `extraAuthPlugins` work was committed as `cd51ef6 feat: support extraAuthPlugins in AuthConfig` — no longer in stash.

---

## What changed (one-paragraph)

The 3 critical correctness bugs (inventory lost-update, order number race, compensation no-remediation), 5 multi-tenancy leak vectors, 6 live bugs, 6 dead-infrastructure documentation lies, and 17-service migration to the typed `defineModule` pattern (replacing `serviceContainer as Record<string, unknown>` at the boundary) are all shipped. The user's pre-Phase-A `extraAuthPlugins` mods are preserved at `git stash@{0}`.

---

## Next session — start here

```bash
cd /Users/mithushancj/Documents/asyncdot/rnd/venture-sell/unified-commerce-engine
git status                    # confirm on foundation-repair
git log --oneline 09f36ba..HEAD  # see all 36 commits

# Read these in this order:
cat sprints/phase-b/HANDOFF.md   # this file
cat sprints/phase-b/WARMDOWN.md  # detailed close-out
cat sprints/phase-b/artifacts/check-types-after-fix5.txt  # last typecheck state
```

---

## Three load-bearing files for the next session

1. `sprints/phase-b/WARMDOWN.md` — full close-out + decisions made + 6 backlog items added (B-13 through B-18).
2. `sprints/phase-b/artifacts/check-types-after-fix5.txt` — last validation state. Shows plugin-wishlist as the one remaining typecheck failure.
3. `FRAMEWORK-WIKI-PHASE-2.md` §10 — the original punch-list. Cross-reference your delivery against this; everything except S5 (typed hooks + framework extraction) is covered.

---

## Traps to know about

- **All plugins now import drizzle through `@unifiedcommerce/core/drizzle`**: any new plugin should follow this pattern; do NOT add `drizzle-orm` as a direct dependency. The `core/drizzle` subpath re-exports `pgTable`, `eq`, `sql`, `PostgresJsDatabase`, etc.
- **`STRICT_ORG_RESOLUTION` defaults to `false`**: existing single-store deployments unaffected. New deployments should set it `true` in `auth.strictOrgResolution` for fail-closed semantics.
- **`getMCPActor()` still hardcoded**: deferred to backlog B-14. Multi-tenant MCP deployments still default to `org_default`. Document in deploy notes if you ship MCP for production.
- **Sprint 5 (typed hooks + framework extraction) was explicitly excluded** from this run by user direction. Backlog B-13 (`HookHandler = never[]`) and B-14 (`getMCPActor` honesty) remain.
- **Excluded test suites** (require live infra): `apps/store-example/test/e2e-full-flow.test.ts` (live Postgres) and `apps/store-example/test/wishlist.test.ts` (live dev server). Run via `bun run test:e2e` when infra is available.
- **Build cache (`tsconfig.build.tsbuildinfo`)** files left out of staged commits — they're build artifacts that regenerate on every build.

---

## Start by running this command

```bash
git log --oneline 09f36ba..HEAD          # see all commits on the branch
bun run check-types && bun run test && bun run lint   # verify all green
```

If anything fails after a fresh clone, run `bun install` first (workspace dep resolution) — but the lockfile is committed, so this should be one-shot clean.

To create the PR: `gh pr create --base main --head foundation-repair`.

To validate the branch's improvements end-to-end with live infra:

```bash
# Terminal 1: run a Postgres
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
# Terminal 2: run the store-example e2e
cd apps/store-example
bun run db:reset
bun run dev &      # for the wishlist live-server tests
bun run test:e2e
```

---

## Branch hygiene

- ✅ All three validation gates green (`check-types`, `test`, `lint`). Branch is mergeable.
- ✅ `extraAuthPlugins` work committed at `cd51ef6`.
- The `.handoff/` directory is gitignored at `result-*.txt` and `schema-*.json`; sentinel `.done` files and `prompt-*.md` files were intentionally NOT committed (they're generated audit trail; can be regenerated from briefs).
- Build cache (`tsconfig.build.tsbuildinfo`) is gitignored implicitly via the per-package `.gitignore` patterns.
