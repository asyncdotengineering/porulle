# Story Brief — `S0-06` Fix starter template + write `packages/core/README.md`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S0-06] starter boots + core README`. **Sentinel mandatory:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s0-06-starter.done` (or `STUCK <reason>`) as the very last action.

---

## 1. Goal

Make `bunx @unifiedcommerce/cli init <name> && cd <name> && bun install && bun run dev` produce a working server in under 5 minutes on a clean machine. Ship a `packages/core/README.md` so the npm install lands with docs.

---

## 1.5 Validation policy (sprint-wide)

**Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.** Manager runs full validation at end of Sprint 4. Your DoD: write the files, stage, commit, sentinel.

**One exception for this specific story:** the smoke test in §4 below IS your validation — running `bunx … init` against your changed template and `bun install` inside the generated project IS the smoke. That's worker-side because the smoke test is the deliverable. But do NOT run `bun run check-types` at the monorepo root or `bun run test` on the suite.

---

## 2. Required reading

1. `sprints/sprint-0/PLAN.md` § S0-06.
2. `FRAMEWORK-WIKI-PHASE-2.md` §8 — DX papercut audit, the "first 5 minutes" story.
3. `packages/cli/templates/starter/` — full directory listing + every file inside. Pay attention to `commerce.config.ts` and `package.json`.
4. `apps/store-example/commerce.config.ts` — **reference for what a working config looks like**.
5. `apps/store-example/drizzle.config.ts` — the canonical drizzle config that successfully migrates core + plugin schemas. Mirror its glob strategy but adjust paths for `node_modules` (since starter consumers install via npm, not workspace).
6. `apps/store-example/.env.example` if it exists, OR `apps/store-example/package.json` to find env vars referenced in scripts.
7. Root `README.md` — for tone / style of the new `packages/core/README.md`.
8. The MEMORY.md "Better Auth Schema Setup" section — the starter must include the auth-schema in its drizzle config (this is the bug from MEMORY that we're closing).

---

## 3. Files to create / modify

**Modify:**
- `packages/cli/templates/starter/commerce.config.ts` — change `database.provider` from `"sqlite"` to `"postgresql"`. Import and pass `postgresAdapter()` from `@unifiedcommerce/adapter-postgres`. Wire the storage adapter (`localStorageAdapter` for dev). Wire the email adapter (or a no-op console adapter for dev).
- `packages/cli/templates/starter/package.json` — ensure `@unifiedcommerce/adapter-postgres` and `@unifiedcommerce/adapter-local-storage` are in `dependencies`. Add `db:push` script and `db:generate` script (mirror store-example's). Add `dev` script. Confirm `"license": "MIT"` is present (S0-01 should have done this).

**Create:**
- `packages/cli/templates/starter/drizzle.config.ts` — point `schema` at:
  - `node_modules/@unifiedcommerce/core/dist/auth/auth-schema.js` (or wherever core's published auth schema lives — verify against the actual `@unifiedcommerce/core/package.json` `exports` map).
  - `node_modules/@unifiedcommerce/core/dist/kernel/database/schema.js` (the core barrel).
  - Glob for any plugin schemas: `node_modules/@unifiedcommerce/plugin-*/dist/**/schema.js`.
  - Use `dialect: "postgresql"`, `dbCredentials: { url: process.env.DATABASE_URL! }`.
- `packages/cli/templates/starter/.env.example` — document every env var the starter reads:
  ```
  DATABASE_URL=postgres://localhost:5432/unified_commerce
  BETTER_AUTH_SECRET=<openssl rand -hex 32>
  BETTER_AUTH_URL=http://localhost:4000
  ```
  (And any others the starter actually consumes — verify against the config file.)
- `packages/cli/templates/starter/README.md` — rewrite. Sections: Prerequisites (Postgres running, Bun installed), Install (`bun install`), Configure (`cp .env.example .env`, edit), Migrate (`bun run db:push`), Run (`bun run dev`), First request (`curl http://localhost:4000/api/health`), Next steps (link to docs). One screen of content. No fictional features.
- `packages/core/README.md` — the npm-published README. Sections: What it is, Install (`bun add @unifiedcommerce/core @unifiedcommerce/adapter-postgres`), Quickstart (5-line config example), Required adapters, Plugin authoring pointer, Link to docs site, Link to GitHub. ≤120 lines.

**Do not touch:**
- `apps/store-example/` — the reference is the reference; don't drift it.
- Any `packages/core/src/`.
- The CLI binary (`packages/cli/src/`) — the `init` command logic is fine; only the template content needs fixing.

---

## 4. Smoke test (manual, in commit body)

After your changes, run from a clean dir (or `/tmp`):

```bash
cd packages/cli && bun run build
node packages/cli/dist/index.js init /tmp/uc-smoke-$(date +%s)
cd /tmp/uc-smoke-*
bun install
cp .env.example .env
```

Capture the output. **Stop after `bun install` succeeds.** Do NOT run `bun run check-types` at the monorepo root, do NOT run the full test suite. Manager validates at the consolidated gate.

If the CLI hasn't been built (`packages/cli/dist/` empty), build it first.

If `bun install` fails inside the generated starter, that IS a failure mode for this story — the starter must install cleanly. Diagnose and fix; if you can't, write a `.handoff/blocked-s0-06-starter.md` with the install error.

---

## 5. Acceptance criteria

1. Starter `commerce.config.ts` uses `postgresql` provider with `postgresAdapter()` wired correctly.
2. Starter `drizzle.config.ts` exists and includes the core auth schema, core schema barrel, and plugin glob.
3. Starter `.env.example` exists with at minimum `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.
4. Starter `package.json` lists `adapter-postgres`, `adapter-local-storage`, has `db:push` / `dev` scripts. License field present.
5. Starter `README.md` rewritten to match the working flow.
6. `packages/core/README.md` exists, ≤120 lines, links to docs.
7. Smoke test as described in §4 — `bun install` succeeds inside the generated starter. Nothing more.

---

## 6. DoD

- [ ] All AC met.
- [ ] Smoke-test output captured in commit body OR in `sprints/sprint-0/artifacts/S0-06-smoke.txt`.
- [ ] No `as any`, no `@ts-ignore`. Don't run monorepo-wide typecheck.
- [ ] Atomic commit `[S0-06] starter boots + core README`.
- [ ] Sentinel `.handoff/result-s0-06-starter.done`.

---

## 7. What NOT to do

- Do NOT modify `apps/store-example`. Reference only.
- Do NOT add SQLite as an option anywhere — the engine is PostgreSQL-only per RFC-002.
- Do NOT add features to the starter beyond a working bare config.
- Do NOT publish a `LICENSE` inside the starter template (the project uses field-only convention; root LICENSE covers consumers).
- Do NOT add fictional bullets to the starter README. Every bullet must reflect actual behavior.

You are the IC. Sincere work only.
