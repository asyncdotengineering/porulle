# Story Brief — `S3-06` Fix docs (installation.mdx + README fictional sections)

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-06] docs match reality`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-06-docs-fix.done`.

---

## 1. Goal

Two doc lies to fix:
- `apps/docs/content/docs/installation.mdx` line ~78 shows the drizzle.config schema glob as `./packages/plugins/*/src/schema.ts` (monorepo path). Installed users need `./node_modules/@unifiedcommerce/plugin-*/src/schema.ts`.
- Root `README.md` has a section "Option 1: Install from npm" referencing `bunx create-unified-commerce` which doesn't exist. Replace with the actual working `bunx @unifiedcommerce/cli init <name>` flow (which `packages/cli/src/commands/init.ts` does support).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §4 + §8.
2. `apps/docs/content/docs/installation.mdx` — full file.
3. Root `README.md` — find the "Option 1" section + any `create-unified-commerce` references.
4. `apps/store-example/drizzle.config.ts` — for the canonical glob pattern.
5. `packages/cli/src/commands/init.ts` — confirm `bunx @unifiedcommerce/cli init` is the working entry.

---

## 3. Files to modify

**Modify:**
- `apps/docs/content/docs/installation.mdx` — schema glob fix + any other monorepo-vs-installed-path drift.
- Root `README.md` — replace the fictional `create-unified-commerce` section with the working `bunx @unifiedcommerce/cli init` flow + a note that the CLI must be installed (or a one-line `bun add -g @unifiedcommerce/cli`).

**Do not touch:**
- The CLI source.
- Other doc files unless they reference the same fictional path.

---

## 4. Acceptance criteria

1. installation.mdx schema glob references `node_modules` paths.
2. Root README's `create-unified-commerce` reference removed; replaced with working flow.
3. Anyone following the docs verbatim from a clean machine reaches a booting server.
4. No `as any`, no `@ts-ignore`.

---

## 5. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S3-06] docs match reality`.
- [ ] Sentinel.

---

## 6. What NOT to do

- Do NOT make `bunx create-unified-commerce` work — that's a separate npm-publishing concern.
- Do NOT rewrite the entire installation doc — surgical fix only.
