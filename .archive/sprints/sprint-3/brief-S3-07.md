# Story Brief — `S3-07` Plugin READMEs (13 packages)

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S3-07] plugin READMEs (13 packages)`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s3-07-plugin-readmes.done`.

---

## 1. Goal

13 of 14 plugin packages have NO README.md. Only `plugin-marketplace/README.md` exists. Write a working README for each — they ship to npm without docs (FRAMEWORK-WIKI-PHASE-2 §8).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §8 (DX papercut audit).
2. `packages/plugins/plugin-marketplace/README.md` — **the model template**.
3. For each missing-README plugin, read its `package.json` + `src/index.ts` + (if present) one route file to understand what the plugin does.

The 13 plugins missing READMEs:
- plugin-appointments
- plugin-gift-cards
- plugin-loyalty
- plugin-notifications
- plugin-pos
- plugin-pos-restaurant
- plugin-procurement
- plugin-production
- plugin-reviews
- plugin-scheduled-orders
- plugin-uom
- plugin-warehouse
- plugin-wishlist

---

## 3. Approach

Common template (~50–80 lines per README):

```markdown
# @unifiedcommerce/plugin-<name>

<one-sentence description>

## Install

\`\`\`bash
bun add @unifiedcommerce/plugin-<name>
\`\`\`

Add to `commerce.config.ts`:

\`\`\`typescript
import { <name>Plugin } from "@unifiedcommerce/plugin-<name>";

export default defineConfig({
  // ...
  plugins: [<name>Plugin()],
});
\`\`\`

Add to `drizzle.config.ts`:

\`\`\`typescript
schema: [
  "./node_modules/@unifiedcommerce/plugin-<name>/src/schema.ts",
  // ...
],
\`\`\`

## What it does

<2–3 sentences explaining the domain>

## Routes exposed

<list of routes this plugin adds, with method + path>

## Hooks

<list of hooks this plugin emits, plus hooks it consumes>

## MCP tools

<list of MCP tools this plugin registers, with one-line descriptions>

## Configuration options

<any plugin-specific config options>

## License

MIT
```

For each plugin, fill in the template by reading the plugin's source.

---

## 4. Files to create

13 × `packages/plugins/plugin-<name>/README.md`.

---

## 5. Acceptance criteria

1. All 13 plugins have a README.md.
2. Every README follows the template.
3. Routes / hooks / MCP tools sections accurately reflect the plugin's actual exports (don't make up features).
4. Each README ≤ 100 lines.

---

## 6. DoD

- [ ] All 13 README.md files exist.
- [ ] Atomic commit `[S3-07] plugin READMEs (13 packages)`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT modify any plugin source — README only.
- Do NOT invent features that don't exist.
- Do NOT exceed 100 lines per README — keep tight.
- Do NOT add a TOC, badges, or marketing copy.
