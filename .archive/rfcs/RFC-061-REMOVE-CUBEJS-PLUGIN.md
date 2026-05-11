# RFC: Remove CubeJS Plugin

**Category:** Architectural Change
**Author:** Claude + Mithushan
**Date:** 2026-04-05
**Status:** Draft
**Related:** RFC-006, RFC-009, RFC-007

---

## 1. Problem Statement

`@unifiedcommerce/plugin-cubejs` adds external infrastructure dependency (a running Cube.js server) for analytics that UC's built-in SQL analytics service already handles. The plugin is marked "not production-ready" in RFC-021, has no consumers in any starter or deployment, and adds 691 lines of code + 632 lines of docs that require maintenance.

Success: zero references to CubeJS anywhere in the codebase. The analytics service continues to work via its built-in SQL query engine. Plugin count drops from 15 to 14. Published package count drops from 33 to 32.

## 2. Background

RFC-006 introduced persistent analytics with a SQL-based query engine. RFC-009 proposed a CubeJS plugin redesign to add caching and pre-aggregation via an external Cube.js server. The plugin was built but never used in production — the SQL analytics service proved sufficient for all current use cases (revenue queries, order aggregations, time-series).

The Cube.js plugin requires:
- A running Cube.js server (separate process)
- `@cubejs-backend/server` + `@cubejs-backend/postgres-driver` (heavy deps)
- JWT token signing for security context
- Model file generation from UC's AnalyticsModel definitions

None of this is used by any starter, deployment, or test suite outside the plugin itself.

## 3. Strict Requirements

- REQ-1: Delete `packages/plugins/plugin-cubejs/` entirely.
- REQ-2: Remove `@cubejs-backend/*` dependencies from `apps/store-example/package.json`.
- REQ-3: Delete `apps/docs/content/docs/guides/cubejs-integration.mdx`.
- REQ-4: Remove CubeJS references from 12 documentation files (analytics-setup, mcp-tools, changelog, meta.json, index pages).
- REQ-5: Unpublish `@unifiedcommerce/plugin-cubejs` from npm (or deprecate).
- REQ-6: Run `scripts/generate-plugin-types.mjs` to regenerate the plugin manifest without cubejs.
- REQ-7: Keep `packages/core/src/modules/analytics/` intact — the SQL analytics service is independent of CubeJS.
- REQ-8: Keep `AnalyticsModel` type and `analyticsModels` plugin capability — other plugins (marketplace) use these for SQL analytics, not CubeJS.
- REQ-9: All existing tests must continue passing (335 runvae, 121 UC core plugin tests).
- REQ-10: Update pitch deck numbers: 32 → 31 packages (if referenced).

## 4. Interface Specification

No new interfaces. This is a pure removal — no code is added.

### 4.1 Removed interfaces

- `cubejsPlugin()` — plugin factory function
- `GET /api/analytics/cubejs/query` — proxy to Cube.js
- `GET /api/analytics/cubejs/meta` — schema metadata
- `GET /api/analytics/cubejs/health` — Cube.js health check
- `cubejs_query` MCP tool — agent tool for Cube.js queries
- `cubejs_meta` MCP tool — agent tool for schema discovery
- `signScopeToken()` — JWT signer for Cube.js security context

## 5. Architecture and System Dependencies

### 5.1 Structural Changes

**Deleted:**
- `packages/plugins/plugin-cubejs/` (entire directory: src, test, config, package.json)

**Modified:**
- `apps/store-example/package.json` — remove `@cubejs-backend/*` deps
- `apps/docs/content/docs/guides/meta.json` — remove cubejs-integration entry
- `apps/docs/content/docs/guides/index.mdx` — remove Cube.js row from table
- `apps/docs/content/docs/guides/analytics-setup.mdx` — remove Cube.js section
- `apps/docs/content/docs/reference/mcp-tools.mdx` — remove cubejs_query, cubejs_meta
- `apps/docs/content/docs/changelog.mdx` — mark RFC-009 as removed
- 3 generated files in `packages/core/src/generated/` — auto-regenerated

**Preserved:**
- `packages/core/src/modules/analytics/` — SQL analytics service (no CubeJS dependency)
- `AnalyticsModel` type in config — used by marketplace and other plugins for SQL analytics
- `analyticsModels` plugin capability — plugins declare analytics models for the SQL engine

### 5.2 Dependencies Removed

- `@cubejs-client/core@1.3.0` (from plugin-cubejs)
- `@cubejs-backend/postgres-driver@1.6.23` (from store-example)
- `@cubejs-backend/server@1.6.23` (from store-example)
- Transitive: `@cubejs-backend/server-core`, `@cubejs-backend/schema-compiler`, `@cubejs-backend/templates`

### 5.3 npm Registry

- Deprecate `@unifiedcommerce/plugin-cubejs@0.5.5` with message: "Removed. Use the built-in SQL analytics service instead."

## 6. Pseudocode

```
1. DELETE packages/plugins/plugin-cubejs/
2. FOR EACH doc_file IN cubejs_references:
     IF file is cubejs-integration.mdx: DELETE
     ELSE: REMOVE cubejs-specific lines, KEEP non-cubejs content
3. REMOVE @cubejs-backend/* from store-example/package.json
4. RUN scripts/generate-plugin-types.mjs
5. RUN tests (vitest packages/, runvae 335 tests)
6. npm deprecate @unifiedcommerce/plugin-cubejs
7. BUMP all package versions, PUBLISH
```

## 7. Code Blueprint

No new code. Removal only.

```bash
# 1. Delete plugin
rm -rf packages/plugins/plugin-cubejs/

# 2. Delete doc
rm apps/docs/content/docs/guides/cubejs-integration.mdx

# 3. Remove from meta.json
# Remove "cubejs-integration" from pages array

# 4. Remove from store-example deps
# Delete @cubejs-backend/* lines from package.json

# 5. Regenerate plugin types
node scripts/generate-plugin-types.mjs

# 6. Verify no orphaned references
grep -r "cubejs\|plugin-cubejs\|Cube\.js" packages/ apps/ --include="*.ts" --include="*.mdx"

# 7. Deprecate on npm
npm deprecate @unifiedcommerce/plugin-cubejs "Removed. Use built-in SQL analytics."
```

## 8. Incremental Task Breakdown

- [ ] **Chunk 1:** Delete `packages/plugins/plugin-cubejs/` -- files: entire directory
- [ ] **Chunk 2:** Remove `@cubejs-backend/*` from `apps/store-example/package.json`
- [ ] **Chunk 3:** Delete `apps/docs/content/docs/guides/cubejs-integration.mdx`, update `meta.json` and `index.mdx`
- [ ] **Chunk 4:** Update `apps/docs/content/docs/guides/analytics-setup.mdx` — remove Cube.js section (lines 73-97)
- [ ] **Chunk 5:** Update `apps/docs/content/docs/reference/mcp-tools.mdx` — remove cubejs_query and cubejs_meta tool docs
- [ ] **Chunk 6:** Update `apps/docs/content/docs/changelog.mdx` — mark RFC-009 as deprecated/removed
- [ ] **Chunk 7:** Run `node scripts/generate-plugin-types.mjs` to regenerate manifests
- [ ] **Chunk 8:** Run `grep -r "cubejs" packages/ apps/docs/` — verify zero remaining references
- [ ] **Chunk 9:** Run tests: `npx vitest run packages/` (UC core), runvae 335 tests
- [ ] **Chunk 10:** `npm deprecate @unifiedcommerce/plugin-cubejs@0.5.5 "Removed. Use built-in SQL analytics."`
- [ ] **Chunk 11:** Bump versions, publish all 32 packages

## 9. Validation and Testing

### 9.1 Fail-to-Pass Tests
None — this is a removal.

### 9.2 Regression Tests (Pass-to-Pass)
- All UC core plugin tests (121 tests)
- All runvae integration tests (335 tests)
- Analytics tests specifically: `test/18-analytics.test.ts` (21 tests — uses SQL analytics, not CubeJS)

### 9.3 Validation Commands

```bash
# No orphaned references
grep -r "cubejs\|plugin-cubejs\|Cube\.js\|@cubejs" packages/ apps/docs/ --include="*.ts" --include="*.mdx" --include="*.json" | grep -v node_modules | grep -v "RFC-" | grep -v "changelog"
# Expected: 0 results

# Plugin types regenerated without cubejs
grep "cubejs" packages/core/src/generated/plugin-manifest.ts
# Expected: 0 results

# Analytics still works (runvae)
API_URL=http://localhost:4001 npx vitest run test/18-analytics.test.ts
# Expected: 21 passed

# Full suite
npx vitest run packages/
# Expected: 0 regressions
```

## 10. Security Considerations

No new attack surface. Removing `signScopeToken()` (JWT signer) and the CubeJS proxy endpoints reduces the attack surface.

## 11. Rollback and Abort Criteria

- Abort if: any analytics test fails after removal (indicates hidden dependency on CubeJS plugin).
- Rollback: `git revert` — the plugin can be restored from the commit before deletion.
- The npm package is deprecated (not unpublished), so existing `0.5.5` installs continue to work.

## 12. Open Questions

None. This is a straightforward removal with no ambiguity.
