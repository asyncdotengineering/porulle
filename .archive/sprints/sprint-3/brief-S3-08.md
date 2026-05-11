# Story Brief — `S3-08` `unicore doctor` CLI command

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-08] unicore doctor command`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-08-doctor.done`.

---

## 1. Goal

New CLI command `unicore doctor` that validates a project's setup. Catches the common first-five-minutes blockers before they crash at runtime (FRAMEWORK-WIKI-PHASE-2 §8).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §8.
2. `packages/cli/src/commands/` — full directory listing. Existing commands: `api-key.ts`, `deploy.ts`, `dev.ts`, `generate-migration.ts`, `import.ts`, `init.ts`, `migrate.ts`. Mirror their patterns.
3. `packages/cli/src/index.ts` — find the command-registration mechanism (commander? cac? bun build-in?).
4. `apps/store-example/commerce.config.ts` + `drizzle.config.ts` — for the patterns the doctor checks.

---

## 3. Checks (the 6 named conditions)

`unicore doctor` runs against the cwd's project and reports green/yellow/red on:

1. **DB reachable**: `process.env.DATABASE_URL` set and `postgres` connection succeeds.
2. **drizzle.config.ts schema covers all customSchemas**: parses `commerce.config.ts` (or imports it dynamically), enumerates plugin schemas, checks each is in the drizzle.config.ts globs.
3. **Auth tables exist**: `SELECT 1 FROM "user" LIMIT 1` succeeds (proxies for "Better Auth schema pushed").
4. **Required env vars set**: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`. Optional ones (`PORT`, etc.) reported as info.
5. **Required adapters configured**: `commerce.config.ts` exports a config with `databaseAdapter`, `storage` (these are required per `kernel.ts`).
6. **CLI version vs core version**: warn if `@unifiedcommerce/core` major version differs from CLI major.

Output:
```
unicore doctor

✓ DATABASE_URL set
✓ Postgres reachable at localhost:5432
✓ drizzle.config.ts covers all 5 plugin schemas
✗ Auth tables not pushed — run `bun run db:push`
ℹ BETTER_AUTH_URL defaults to http://localhost:4000
✓ Storage adapter configured (s3StorageAdapter)
✓ Database adapter configured (postgresAdapter)
✓ CLI 0.5.14 matches core 0.5.14

Result: 1 problem found.
```

Exit non-zero on any red.

---

## 4. Files to create / modify

**Create:**
- `packages/cli/src/commands/doctor.ts` — the command + check implementations.

**Modify:**
- `packages/cli/src/index.ts` — register the new `doctor` command.

**Do not touch:**
- Other commands.
- Core code.

---

## 5. Acceptance criteria

1. `bunx @unifiedcommerce/cli doctor` runs the 6 checks.
2. Each failure has an actionable message ("run X to fix").
3. Exit code: 0 on all green, 1 on any red.
4. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-08] unicore doctor command`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT add more checks than the 6 named ones (scope discipline).
- Do NOT auto-fix anything — diagnose only.
- Do NOT introduce a config validation library.
