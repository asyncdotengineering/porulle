# Story Brief — `S0-01` Add MIT LICENSE to repo root + every package.json

> **You are the IC engineer (`claude-glm` worker, fresh process for this story; clean context window) with no prior context.** This brief is self-contained. Read it end-to-end before writing any code. If anything in this brief is ambiguous or contradicts what you find on disk, **stop and ask** rather than guess.
>
> **Atomic-commit policy:** when you finish, stage every file you create / modify and commit atomically with `[S0-01] license repo + all packages MIT`. Do NOT push. Do NOT make multiple commits per story. Manager handles fix-pass and closeout commits later. **You are on branch `foundation-repair` — do NOT switch branches.**

---

## 1. Goal

Add a standard MIT LICENSE file at the repo root and a `"license": "MIT"` field to every `package.json` in `packages/**` and `apps/**` (35 packages + 5 apps) so the codebase ceases to be "all rights reserved" by default.

---

## 2. Required reading (in this order)

Read these files **in full** before touching code. They are the contract.

1. `sprints/STATE.md` — current sprint pointer.
2. `sprints/sprint-0/PLAN.md` — find the section for `S0-01`.
3. `sprints/WBS.md` § Sprint 0 (the RFC-S0 block).
4. `FRAMEWORK-WIKI-PHASE-2.md` §10 Tier 3 #15 (the source punch-list entry that motivated this story).
5. The repo's existing license precedent: `apps/fashion-starter/LICENSE` (Medusa-inherited; **do not modify**).
6. The current root: `cat package.json` to see the existing top-level shape.

---

## 3. Files you will create or modify

Be explicit. The reviewer will check that you didn't touch anything else.

**Create:**
- `LICENSE` — standard MIT text, copyright `2026 unified-commerce-engine contributors`. Use the canonical SPDX MIT text verbatim (see https://spdx.org/licenses/MIT.html). Single file at the repo root.

**Modify (add `"license": "MIT"` field):**
- All 35 `packages/*/package.json` and `packages/*/*/package.json` files.
- All `apps/*/package.json` files (5 apps under `apps/`) — except `apps/fashion-starter/package.json` if it already has a license field; check first and only add if absent.

Verify the full list with:
```bash
ls packages/*/package.json packages/*/*/package.json apps/*/package.json
```

The exact 35 packages (confirmed by manager pre-flight):
```
packages/adapters/{adapter-local-storage,adapter-meilisearch,adapter-pg-search,adapter-postgres,adapter-r2,adapter-resend,adapter-s3,adapter-ses,adapter-stripe,adapter-tax-manual,adapter-taxjar}/package.json
packages/cli/package.json
packages/core/package.json
packages/db/package.json
packages/eslint-config/package.json
packages/import/{import-flat,import-shopify,import-woocommerce}/package.json
packages/plugins/{plugin-appointments,plugin-gift-cards,plugin-loyalty,plugin-marketplace,plugin-notifications,plugin-pos-restaurant,plugin-pos,plugin-procurement,plugin-production,plugin-reviews,plugin-scheduled-orders,plugin-uom,plugin-warehouse,plugin-wishlist}/package.json
packages/sdk/package.json
packages/typescript-config/package.json
packages/ui/package.json
```

**Field placement convention:** add `"license": "MIT"` immediately after the `"version"` field (or `"name"` if no version). If a package.json already has `"license"`, leave it alone — but **note in your commit body which packages already had one**.

**Do not touch:**
- The root `package.json` already has `"private": true` — DO NOT add a license field to it (it's the workspace root, not a publishable package). The LICENSE file at repo root is sufficient.
- `apps/fashion-starter/LICENSE` — inherited from a Medusa fork; out of scope.
- Any source code (`packages/**/src/**`).
- Any docs (`*.md` other than where you mention this story in your commit body).
- The `sprints/` directory (manager territory).

---

## 4. Acceptance criteria (numbered, in priority order)

1. `LICENSE` file at repo root contains the canonical MIT license text with copyright line `Copyright (c) 2026 unified-commerce-engine contributors`.
2. Every one of the 35 `packages/*/package.json` and `packages/*/*/package.json` files has `"license": "MIT"`.
3. Every `apps/*/package.json` (5 apps) has `"license": "MIT"` UNLESS that app already has a license field that should not be overridden — in that case, leave it and note in the commit body.
4. Running `find packages apps -name 'package.json' -not -path '*/node_modules/*' -exec grep -L '"license"' {} +` returns empty (no package.json without a license field, except the root).
5. `bun install` succeeds without errors after the changes (verify the JSON is still valid).

---

## 5. Definition of Done (universal)

Every box must be ticked before you commit:

- [ ] All acceptance criteria met.
- [ ] `bun install` runs cleanly post-change (just to confirm no JSON syntax errors).
- [ ] No `--no-verify`, no other shortcuts.
- [ ] Atomic commit with message `[S0-01] license repo + all packages MIT`. Body summarizes count of files modified and any package.json that already had a license field.
- [ ] No files modified outside §3 above.

---

## 6. What NOT to do

- Do NOT add a license field to the root `package.json` (it's marked `private: true` — workspace root, not published).
- Do NOT modify `apps/fashion-starter/LICENSE`.
- Do NOT change any other package.json fields (no version bumps, no dependency tweaks, no script changes).
- Do NOT introduce a `LICENSE` file inside any sub-package — the root LICENSE + the `"license": "MIT"` field is the convention.
- Do NOT push the commit. Do NOT create multiple commits.
- Do NOT switch branches. You're on `foundation-repair`.

---

## 7. Demo artifact

After the commit, capture the diff stat and license check output:

```bash
git diff HEAD~1 --stat > sprints/sprint-0/artifacts/S0-01-diff.txt
find packages apps -name 'package.json' -not -path '*/node_modules/*' -exec grep -L '"license"' {} + > sprints/sprint-0/artifacts/S0-01-missing-license.txt
```

The first should show 35+ package.json + 1 LICENSE file. The second should be empty (no missing-license files).

Stage these artifact files into the same commit OR amend the commit body to include their summary inline.

---

## 8. How to report back

When you finish:

1. Print the commit sha and a one-line summary.
2. Print `git diff HEAD~1 --stat` output.
3. Print the missing-license check output (should be empty).
4. List any package.json that already had a license field (if any).

---

## 9. If you get stuck

- If a package.json has invalid JSON before you start: stop. Report what you found.
- If `bun install` fails post-change: stop. Report the error.
- If the file count doesn't match (35 packages + 5 apps): stop. Report what you actually counted.

You are the IC. Sincere work is the only kind we ship. If you didn't run a check, say so.
