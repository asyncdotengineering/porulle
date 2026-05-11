# RFC-009: Cube.js Plugin Redesign + Analytics Naming Cleanup

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-15
- **Scope:** `packages/adapters/adapter-cubejs/` -> `packages/plugins/plugin-cubejs/`, `packages/core/src/modules/analytics/`, `packages/plugins/plugin-marketplace/`
- **Depends on:** RFC-006 (persistent analytics), RFC-007 (scoped analytics)
- **Estimated effort:** Half day
- **Priority:** Medium -- architectural cleanup, no user-facing bugs

---

## 1. Problem

The Cube.js integration is currently designed as an **adapter swap**: the user replaces the default `DrizzleAnalyticsAdapter` with `CubeJsAnalyticsAdapter` via `config.analytics.adapter`. This creates three problems:

### P1: All-or-nothing replacement

When the user configures Cube.js, the Drizzle adapter is never instantiated (kernel.ts line 310). If Cube.js is down, **all analytics are down**. There is no degradation path because the default adapter was never created.

```typescript
// Current kernel.ts (line 310-313)
const analyticsAdapter = config.analytics?.adapter      // CubeJs wins
  ?? new DrizzleAnalyticsAdapter(db, { ... });           // Drizzle SKIPPED
```

### P2: External dependency in the hot path

Every analytics query -- including simple "how many orders today?" from an AI agent -- routes through an external HTTP service. A 3-container Docker stack (Cube API + refresh worker + Cube Store) becomes a hard dependency for basic analytics that PostgreSQL handles directly in milliseconds.

### P3: Inconsistent extension pattern

Every other extension to the engine is a plugin (marketplace, POS, loyalty, subscriptions). The Cube.js adapter is the only thing that uses a raw `config.analytics.adapter` property to swap internals. This is a leaky abstraction that exposes engine internals to the user.

### P4: Confusing "Cube" naming in core

Core's analytics schema types are named `CubeDefinition`, `CubeScopeRule`, `BUILTIN_CUBES`. These have nothing to do with Cube.js — they're generic analytics model definitions that the Drizzle adapter compiles into SQL. But the naming implies a Cube.js dependency where none exists. A developer reading `CubeDefinition` in core will ask "do I need Cube.js?" The answer is no — it's just a declarative mapping of semantic names (e.g., `Orders.revenue`) to SQL expressions (e.g., `SUM(grand_total)`). The naming should reflect what these things actually are: analytics models.

---

## 2. Proposed Design

Redesign the Cube.js package as an **additive plugin** that coexists alongside the default Drizzle analytics. The Drizzle adapter is always present. Cube.js adds a parallel, cached analytics layer on top.

### Architecture: Before vs After

**Before (adapter swap):**
```
/api/analytics/query  ──→  CubeJsAdapter ──→ Cube.js ──→ PG
                           (Drizzle never created)
```

**After (additive plugin):**
```
/api/analytics/query  ──→  DrizzleAdapter ──→ PostgreSQL    (always works)
/api/cubejs/query     ──→  CubeJsPlugin  ──→ Cube.js ──→ PG (optional, cached)
/api/cubejs/meta      ──→  CubeJsPlugin  ──→ Cube.js metadata
/api/cubejs/status    ──→  CubeJsPlugin  ──→ health check
```

Both coexist. Core analytics never break. Cube.js adds pre-aggregation speed and BI tool connectivity on top.

### User-facing change

```typescript
// Before: raw adapter swap (leaky abstraction)
import { cubeJsAnalyticsAdapter } from "@unifiedcommerce/adapter-cubejs";

defineConfig({
  analytics: {
    adapter: cubeJsAnalyticsAdapter({
      apiUrl: "http://localhost:4000/cubejs-api/v1",
      apiToken: process.env.CUBEJS_API_SECRET,
    }),
  },
});

// After: standard plugin pattern (consistent with marketplace, POS)
import { cubeJsPlugin } from "@unifiedcommerce/plugin-cubejs";

defineConfig({
  plugins: [
    cubeJsPlugin({
      apiUrl: "http://localhost:4000/cubejs-api/v1",
      apiToken: process.env.CUBEJS_API_SECRET,
    }),
  ],
});

// Model files generated at build time, not runtime:
// npx plugin-cubejs generate-models --config ./commerce.config.ts --output ./cube/model/
```

---

## 3. What the Plugin Provides

### 3.1 Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/cubejs/query` | Execute a query through Cube.js (pre-aggregated) |
| `GET` | `/api/cubejs/meta` | Return Cube.js metadata (cubes, measures, dimensions) |
| `GET` | `/api/cubejs/status` | Health check: is Cube.js reachable? |
| `POST` | `/api/cubejs/refresh` | Trigger pre-aggregation rebuild (admin only) |

All routes enforce the same scope rules via `buildAnalyticsScope(actor)` and per-query JWT signing.

### 3.2 MCP Tools (for AI agents)

| Tool | Description |
|------|-------------|
| `cubejs_query` | Query Cube.js with pre-aggregation caching. Same params as `analytics_query`. |
| `cubejs_meta` | Discover available cubes/measures/dimensions from Cube.js instance. |

Agents can choose: use `analytics_query` (direct SQL, always fresh) or `cubejs_query` (pre-aggregated, sub-second, possibly stale by refresh interval).

### 3.3 Build-time Model Generation (CLI)

The current adapter writes `.js` model files to disk **at runtime** when the server boots. This breaks in production environments:

- **Serverless (Vercel, Lambda):** No persistent writable filesystem
- **Read-only containers:** Many production Docker setups mount app code as read-only
- **Multiple replicas:** Replica 1 writes the file, replicas 2-N don't have it
- **Separate deploy pipelines:** Cube.js and the commerce engine may deploy independently

The plugin replaces runtime file generation with a **build-time CLI command**:

```bash
# Run during CI/CD or local development
npx plugin-cubejs generate-models --config ./commerce.config.ts --output ./cube/model/
```

This command:
1. Loads the commerce config (including all plugins, which register their `analyticsModels`)
2. Converts each `AnalyticsModel` into a Cube.js `.js` model file via `generateCubeModel()`
3. Writes the files to the output directory
4. Also copies `cube-config.example.js` as a starting point for `queryRewrite`

The generated files are **committed to the repo** or **baked into the Cube.js Docker image** during the build step. No runtime file writing needed. This is the same pattern as `drizzle-kit generate` — you run it at build time, commit the output, deploy it.

```yaml
# Example CI/CD step
- name: Generate Cube.js models
  run: npx plugin-cubejs generate-models --config ./commerce.config.ts --output ./cube/model/

- name: Build Cube.js image
  run: docker build -f Dockerfile.cubejs -t myapp/cubejs .
  # Dockerfile.cubejs COPYs ./cube/model/ into the image
```

For local development, the plugin also supports a `--watch` flag that regenerates model files when the config changes:

```bash
npx plugin-cubejs generate-models --config ./commerce.config.ts --output ./cube/model/ --watch
```

### 3.3.1 How the CLI works for npm users

The CLI works identically whether the user is in the monorepo or installed packages from npm. The `package.json` has a `bin` field:

```json
{
  "name": "@unifiedcommerce/plugin-cubejs",
  "bin": {
    "plugin-cubejs": "./dist/cli.js"
  }
}
```

When the user runs `npx plugin-cubejs generate-models --config ./commerce.config.ts`, the CLI:

1. **Imports the user's config file** via dynamic `import(path.resolve(configPath))`. This triggers `defineConfig()` which runs all plugin config transforms.
2. **Collects all AnalyticsModels**: the built-in models from `@unifiedcommerce/core` (`BUILTIN_ANALYTICS_MODELS`) plus any models registered by plugins via the `analyticsModels` manifest slot (available in `config.analytics.models`).
3. **Generates `.js` files** for each model using `generateCubeModel()`.

```typescript
// cli.ts (simplified internals)
const configModule = await import(path.resolve(configPath));
const config = await configModule.default;

const { BUILTIN_ANALYTICS_MODELS } = await import("@unifiedcommerce/core");
const pluginModels = config.analytics?.models ?? [];

for (const model of [...BUILTIN_ANALYTICS_MODELS, ...pluginModels]) {
  const content = generateCubeModel(model);
  await fs.writeFile(path.join(outputDir, `${model.name}.js`), content);
}
```

This is the same pattern as `drizzle-kit generate` — load the user's config, resolve all schemas, produce output files. Works in monorepos, standalone npm projects, and CI/CD pipelines.

```
npm-user-project/
├── commerce.config.ts        ← imports @unifiedcommerce/* from node_modules
├── package.json              ← @unifiedcommerce/plugin-cubejs in dependencies
├── cube/
│   └── model/                ← output: Orders.js, Inventory.js, etc.
└── node_modules/
    └── @unifiedcommerce/
        ├── core/             ← BUILTIN_ANALYTICS_MODELS
        ├── plugin-cubejs/    ← CLI binary + generateCubeModel()
        └── plugin-marketplace/ ← MARKETPLACE_ANALYTICS_MODELS (if installed)
```

### 3.4 Scope Security

Unchanged from current implementation. The plugin signs a per-query HS256 JWT containing `{ role, vendorId, customerId }` claims. Cube.js's `queryRewrite` reads these claims and injects WHERE filters. The `cube-config.example.js` reference file is included in the package.

---

## 4. Implementation Steps

### Step 1: Rename and restructure package

```
packages/adapters/adapter-cubejs/     →  packages/plugins/plugin-cubejs/
```

| Old file | New file | Change |
|----------|----------|--------|
| `src/index.ts` | `src/index.ts` | Rewrite: export `cubeJsPlugin()` via `defineCommercePlugin` |
| `src/scope-token.ts` | `src/scope-token.ts` | Keep as-is |
| `src/model-generator.ts` | `src/model-generator.ts` | Keep as-is (accepts `AnalyticsModel`, generates `.js`) |
| `src/cube-config.example.js` | `src/cube-config.example.js` | Keep as-is |
| — | `src/cli.ts` | **New:** CLI entry point for `generate-models` command |
| `test/scope-token.test.ts` | `test/scope-token.test.ts` | Keep as-is |
| `package.json` | `package.json` | Rename to `@unifiedcommerce/plugin-cubejs`, add `bin` field |

### Step 2: Implement plugin entry point

The new `src/index.ts` uses `defineCommercePlugin`:

```typescript
import { defineCommercePlugin } from "@unifiedcommerce/core";
import { signScopeToken } from "./scope-token.js";
import { generateCubeModel } from "./model-generator.js";
import cube from "@cubejs-client/core";

export const cubeJsPlugin = (options: CubeJsPluginOptions) =>
  defineCommercePlugin({
    id: "cubejs",
    version: "0.1.0",

    routes: (ctx) => buildCubeJsRoutes(ctx, options),
    mcpTools: (ctx) => buildCubeJsMcpTools(ctx, options),
  });
```

The plugin creates a lightweight internal client (wrapping `@cubejs-client/core`) that:
- Signs per-query JWTs from the actor's scope
- Probes `/readyz` for health checks

Model generation is handled by the CLI (`src/cli.ts`), not at runtime. The plugin itself never writes to disk.

### Step 3: Remove adapter swap from core

**`packages/core/src/config/types.ts`** -- remove `adapter` from `AnalyticsConfig`:

```typescript
// Before
export interface AnalyticsConfig {
  customSchemaPath?: string;
  preAggregationRefreshHours?: number;
  models?: unknown[];
  adapter?: import("../modules/analytics/types").AnalyticsAdapter;  // DELETE
}

// After
export interface AnalyticsConfig {
  customSchemaPath?: string;
  preAggregationRefreshHours?: number;
  models?: unknown[];
}
```

**`packages/core/src/runtime/kernel.ts`** -- simplify to always use Drizzle:

```typescript
// Before (line 310-313)
const analyticsAdapter = config.analytics?.adapter
  ?? new DrizzleAnalyticsAdapter(db, { ... });

// After
const analyticsAdapter = new DrizzleAnalyticsAdapter(db, {
  refreshHours: config.analytics?.preAggregationRefreshHours ?? 1,
});
```

### Step 4: Move MARKETPLACE_CUBES to plugin-marketplace

**`packages/core/src/modules/analytics/cubes.ts`** -- remove `VENDOR_ORDERS_CUBE`, `VENDOR_BALANCE_CUBE`, `VENDOR_REVIEWS_CUBE` and the `MARKETPLACE_CUBES` export. Keep `BUILTIN_CUBES` (Orders, OrderLineItems, Customers, Inventory).

**`packages/core/src/index.ts`** -- remove `MARKETPLACE_CUBES` export.

**`packages/core/src/runtime/kernel.ts`** -- remove the `MARKETPLACE_CUBES` registration loop (lines 317-321). Plugins register their own models via the `analyticsModels` manifest slot, which the kernel already processes at line 384-385.

**`packages/plugins/plugin-marketplace/src/index.ts`** -- add `analyticsModels` to the manifest:

```typescript
defineCommercePlugin({
  id: "marketplace",
  version: "0.1.0",
  schema: () => ({ vendors, vendorSubOrders, ... }),
  hooks: () => buildHooks(),
  routes: (ctx) => [...],
  mcpTools: (ctx) => [...],
  analyticsModels: () => [VENDOR_ORDERS_CUBE, VENDOR_BALANCE_CUBE, VENDOR_REVIEWS_CUBE],
});
```

The cube definitions themselves (`VENDOR_ORDERS_CUBE`, etc.) move to a new file `packages/plugins/plugin-marketplace/src/analytics-cubes.ts`. They remain structurally identical — only the location changes.

### Step 5: Clean up dead analytics config

**`packages/core/src/config/types.ts`** -- remove `preAggregationRefreshHours` from `AnalyticsConfig`. This value was only meaningful for Cube.js pre-aggregations. The Drizzle adapter queries PostgreSQL live on every request — it stored `refreshHours` but never used it.

**`packages/core/src/modules/analytics/drizzle-adapter.ts`** -- remove `refreshHours` field and the decorative `preAggregation` metadata from query/meta responses. The `preAggregation` field on `AnalyticsQueryResult` becomes optional (already typed as `preAggregation?`). Only the Cube.js plugin populates it with real values.

### Step 6: Rename Cube terminology to Analytics terminology

All "Cube" names in core refer to generic analytics model definitions, not Cube.js. Rename to eliminate confusion:

**Type renames (across all files in core + plugins):**

| Current | New | Files affected |
|---------|-----|----------------|
| `CubeDefinition` | `AnalyticsModel` | types.ts, drizzle-adapter.ts, cubes.ts → models.ts, kernel.ts, index.ts, plugin-marketplace, plugin-cubejs |
| `CubeScopeRule` | `AnalyticsScopeRule` | types.ts, cubes.ts → models.ts |
| `MeasureDefinition` | `AnalyticsMeasure` | types.ts, drizzle-adapter.ts |
| `DimensionDefinition` | `AnalyticsDimension` | types.ts, drizzle-adapter.ts |
| `JoinDefinition` | `AnalyticsJoin` | types.ts, drizzle-adapter.ts |

**Constant renames:**

| Current | New | Files affected |
|---------|-----|----------------|
| `BUILTIN_CUBES` | `BUILTIN_ANALYTICS_MODELS` | cubes.ts → models.ts, kernel.ts, index.ts |
| `MARKETPLACE_CUBES` | `MARKETPLACE_ANALYTICS_MODELS` | cubes.ts (deleted from core), plugin-marketplace |
| `ORDERS_CUBE` | `ORDERS_MODEL` | cubes.ts → models.ts |
| `ORDER_LINE_ITEMS_CUBE` | `ORDER_LINE_ITEMS_MODEL` | cubes.ts → models.ts |
| `INVENTORY_CUBE` | `INVENTORY_MODEL` | cubes.ts → models.ts |
| `CUSTOMERS_CUBE` | `CUSTOMERS_MODEL` | cubes.ts → models.ts |
| `VENDOR_ORDERS_CUBE` | `VENDOR_ORDERS_MODEL` | plugin-marketplace |
| `VENDOR_BALANCE_CUBE` | `VENDOR_BALANCE_MODEL` | plugin-marketplace |
| `VENDOR_REVIEWS_CUBE` | `VENDOR_REVIEWS_MODEL` | plugin-marketplace |

**File rename:**

| Current | New |
|---------|-----|
| `packages/core/src/modules/analytics/cubes.ts` | `packages/core/src/modules/analytics/models.ts` |

**Method renames:**

| Current | New | Files affected |
|---------|-----|----------------|
| `registerCube()` | `registerModel()` | AnalyticsAdapter interface (types.ts), DrizzleAnalyticsAdapter, kernel.ts |

**Export updates in `packages/core/src/index.ts`:**

```diff
- export { BUILTIN_CUBES } from "./modules/analytics/cubes";
+ export { BUILTIN_ANALYTICS_MODELS } from "./modules/analytics/models";
- export { MARKETPLACE_CUBES } from "./modules/analytics/cubes";
  // (MARKETPLACE deleted — moves to plugin-marketplace)

- export type { CubeDefinition, CubeScopeRule, MeasureDefinition, DimensionDefinition }
+ export type { AnalyticsModel, AnalyticsScopeRule, AnalyticsMeasure, AnalyticsDimension }
```

Core re-exports the old names as deprecated type aliases for one release cycle:

```typescript
/** @deprecated Use AnalyticsModel instead */
export type CubeDefinition = AnalyticsModel;
/** @deprecated Use AnalyticsScopeRule instead */
export type CubeScopeRule = AnalyticsScopeRule;
```

### Step 7: Delete old package

```bash
rm -rf packages/adapters/adapter-cubejs/
```

### Step 9: Update documentation

- `guides/cubejs-integration.mdx` -- update config examples to use plugin pattern
- `guides/analytics-setup.mdx` -- remove "Switching to Cube.js" section (replaced by plugin guide); remove marketplace cubes from "available measures" (they're documented in marketplace plugin docs)
- `reference/adapters.mdx` -- remove CubeJsAnalyticsAdapter reference

### Step 10: Update workspace references

- Root `package.json` or workspace config: remove `adapter-cubejs`, add `plugin-cubejs`
- Any `tsconfig` project references

---

## 5. What We Keep vs Remove

### Keep (moves to plugin-cubejs)

| File | Reason |
|------|--------|
| `scope-token.ts` | Per-query JWT signing -- core security mechanism |
| `model-generator.ts` | Converts AnalyticsModel → Cube.js `.js` model files (used by CLI, not runtime) |
| `cube-config.example.js` | Reference queryRewrite for scope enforcement |
| `scope-token.test.ts` | 9 unit tests for JWT signing |
| Health check logic | `/readyz` probing with 30s cache |

### Remove

| Thing | Reason |
|-------|--------|
| `CubeJsAnalyticsAdapter` class | No longer implements `AnalyticsAdapter` interface -- plugin has its own internal client |
| `config.analytics.adapter` property | Drizzle is always the adapter. No swap mechanism needed. |
| `?? DrizzleAnalyticsAdapter` conditional in kernel | Always Drizzle. |
| `setFallback()` / fallback logic | No fallback needed -- Drizzle is always present for `/api/analytics/*` |

### Move to plugin-marketplace

| Thing | Reason |
|-------|--------|
| `MARKETPLACE_CUBES` (VendorOrders, VendorBalance, VendorReviews) | These define analytics over marketplace tables (`marketplace_vendor_sub_orders`, `marketplace_vendor_balances`, `marketplace_vendor_reviews`). Those tables don't exist unless the marketplace plugin is installed. The kernel currently registers them blindly with a "queries return empty if tables don't exist" comment — that's a code smell. The marketplace plugin should own its own analytics models via `analyticsModels` in its manifest. |

### Remove from core

| Thing | Reason |
|-------|--------|
| `MARKETPLACE_CUBES` export from `cubes.ts` | Moves to plugin-marketplace |
| `for (const cube of MARKETPLACE_CUBES)` loop in kernel.ts | Plugin registers its own models via `analyticsModels` manifest slot |
| `preAggregationRefreshHours` from `AnalyticsConfig` | Only meaningful for Cube.js pre-aggregations. Drizzle queries PostgreSQL live — this value is decorative metadata that the adapter doesn't use. |
| `refreshHours` from `DrizzleAnalyticsAdapter` | Same reason. The `preAggregation` response field becomes optional — only the Cube.js plugin populates it with real values. |

### Keep in Core (renamed)

| Thing | New Name | Reason |
|-------|----------|--------|
| `AnalyticsAdapter` interface | `AnalyticsAdapter` (unchanged) | Internal contract for DrizzleAdapter |
| `DrizzleAnalyticsAdapter` | `DrizzleAnalyticsAdapter` (unchanged) | The default, always-on analytics engine |
| `CubeDefinition` types | `AnalyticsModel` | Used by plugins to register analytics models. Renamed to remove Cube.js naming confusion. |
| `CubeScopeRule` | `AnalyticsScopeRule` | Role-based filtering rules. Same rename rationale. |
| `buildAnalyticsScope()` | `buildAnalyticsScope()` (unchanged) | Provider-neutral scope builder |
| `BUILTIN_CUBES` | `BUILTIN_ANALYTICS_MODELS` | Core tables (Orders, OrderLineItems, Customers, Inventory) that always exist |
| `registerCube()` | `registerModel()` | Method on AnalyticsAdapter interface |
| `cubes.ts` | `models.ts` | File rename to match new terminology |
| `/api/analytics/*` routes | unchanged | Core analytics, always works |
| `analytics_query` / `analytics_meta` MCP tools | unchanged | Core MCP tools, always works |

---

## 6. Migration for Existing Users

Any user currently using `config.analytics.adapter` switches to the plugin:

```diff
- import { cubeJsAnalyticsAdapter } from "@unifiedcommerce/adapter-cubejs";
+ import { cubeJsPlugin } from "@unifiedcommerce/plugin-cubejs";

  defineConfig({
-   analytics: {
-     adapter: cubeJsAnalyticsAdapter({
-       apiUrl: "http://localhost:4000/cubejs-api/v1",
-       apiToken: process.env.CUBEJS_API_SECRET,
-     }),
-   },
+   plugins: [
+     cubeJsPlugin({
+       apiUrl: "http://localhost:4000/cubejs-api/v1",
+       apiToken: process.env.CUBEJS_API_SECRET,
+     }),
+   ],
  });
```

Add a build step to generate Cube.js model files:
```diff
+ # package.json scripts
+ "cubejs:generate": "plugin-cubejs generate-models --config ./commerce.config.ts --output ./cube/model/"
```

Frontend code changes endpoint:
```diff
- POST /api/analytics/query  (was routed to Cube.js)
+ POST /api/cubejs/query     (explicit Cube.js endpoint)
```

The original `/api/analytics/query` still works -- it just routes to Drizzle now (which it should have been doing all along).

---

## 7. Package Naming

Follows existing conventions:

| Type | Pattern | Examples |
|------|---------|----------|
| Plugins | `packages/plugins/plugin-{name}/` | plugin-marketplace, plugin-pos, **plugin-cubejs** |
| Adapters | `packages/adapters/adapter-{name}/` | adapter-stripe, adapter-s3, adapter-meilisearch |

The Cube.js package moves from `adapters/` to `plugins/` because it is no longer a drop-in adapter replacement. It's an additive plugin that registers routes and MCP tools.

**npm name:** `@unifiedcommerce/plugin-cubejs`

---

## 8. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Breaking change for adapter users | Low (no known production deployments) | Clear migration path in docs |
| Plugin boot fails if Cube.js not running | Expected | Plugin catches connection errors; routes return clear error messages. Core analytics unaffected. |
| Model file generation race with Cube.js | Low | Cube.js hot-reloads model files. Slight delay on first boot is acceptable. |

---

## 9. Success Criteria

### Plugin restructure
- [x] `packages/plugins/plugin-cubejs/` exists with `defineCommercePlugin` entry point
- [x] `packages/adapters/adapter-cubejs/` deleted
- [x] Plugin registers 4 routes: `/api/cubejs/query`, `/api/cubejs/meta`, `/api/cubejs/status`, `/api/cubejs/refresh`
- [x] Plugin registers 2 MCP tools: `cubejs_query`, `cubejs_meta`
- [x] All routes enforce scope via `buildAnalyticsScope` + per-query JWT
- [x] CLI command `npx plugin-cubejs generate-models` produces Cube.js `.js` model files at build time
- [x] No runtime file writing — plugin never touches the filesystem

### Core cleanup
- [x] `config.analytics.adapter` removed from `AnalyticsConfig` type
- [x] `preAggregationRefreshHours` removed from `AnalyticsConfig`
- [x] `refreshHours` removed from `DrizzleAnalyticsAdapter`
- [x] Kernel always creates `DrizzleAnalyticsAdapter` (no conditional, no marketplace model loop)

### Naming cleanup
- [x] `CubeDefinition` → `AnalyticsModel` (all files)
- [x] `CubeScopeRule` → `AnalyticsScopeRule` (all files)
- [x] `MeasureDefinition` → `AnalyticsMeasure` (all files)
- [x] `DimensionDefinition` → `AnalyticsDimension` (all files)
- [x] `JoinDefinition` → `AnalyticsJoin` (all files)
- [x] `BUILTIN_CUBES` → `BUILTIN_ANALYTICS_MODELS`
- [x] `registerCube()` → `registerModel()` on AnalyticsAdapter interface
- [x] `cubes.ts` → `models.ts`
- [x] Deprecated type aliases exported for one release cycle

### Marketplace model ownership
- [x] `MARKETPLACE_CUBES` → `MARKETPLACE_ANALYTICS_MODELS` moved to `plugin-marketplace`
- [x] Marketplace plugin uses `analyticsModels` manifest slot
- [x] Marketplace analytics models appear in `/api/analytics/meta` when plugin is installed

### Verification
- [x] Core analytics tests pass (266+) with zero changes
- [x] Scope token tests pass (9)
- [x] Documentation updated
