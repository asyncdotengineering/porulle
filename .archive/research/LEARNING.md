# What I Learned Building This — Notes for the Next Developer

Last updated: 2026-03-16

This document captures hard-won knowledge from building UnifiedCommerce Engine across 12 RFCs, 598 tests, and 65+ commits. Read this before touching the codebase.

---

## 1. Drizzle ORM Gotchas

### null vs undefined

Drizzle returns `null` for nullable columns, never `undefined`. JavaScript's `!== undefined` does NOT catch `null`. Always use `!= null` (loose equality) to handle both.

**The bug that bit us:** `inventoryLevels.variantId` is nullable. `findLevelsByEntityAndVariant(entityId, null)` used `eq(col, null)` which generates `col = NULL` (always false in SQL). The fix: use `isNull(col)` for NULL checks, never pass `null` to `eq()`.

### exactOptionalPropertyTypes

The tsconfig has `exactOptionalPropertyTypes: true`. This means `{ field?: string }` and `{ field?: string | undefined }` are DIFFERENT types. Zod's `.optional()` produces the second form. Service input types use the first.

**Solution:** `stripUndefined()` utility strips keys with `undefined` values before passing to services. Located at `packages/plugins/plugin-marketplace/src/routes/util.ts` and used in `packages/core/src/interfaces/rest/router.ts`.

### Self-referencing foreign keys

```typescript
// WRONG — uses 'any'
parentId: uuid("parent_id").references((): any => categories.id)

// RIGHT — use AnyPgColumn from drizzle-orm/pg-core
import { AnyPgColumn } from "drizzle-orm/pg-core";
parentId: uuid("parent_id").references((): AnyPgColumn => categories.id)
```

### Driver-agnostic database type

Use `PgDatabase<PgQueryResultHKT>` from `drizzle-orm/pg-core`, NOT `PostgresJsDatabase`. Both postgres-js (production) and PGlite (tests) extend it. No double-casts needed.

---

## 2. Hono + @hono/zod-openapi Patterns

### OpenAPIHono vs Hono

All routers use `OpenAPIHono` (extends `Hono`). It supports both `router.get(path, handler)` (legacy) and `router.openapi(routeDef, handler)` (documented in spec). Both work on the same instance.

### The `@ts-expect-error` pattern

`router.openapi(route, handler)` enforces strict return typing — the handler must return exactly the 200 response schema type. But real handlers return union responses (200 | 400 | 422). We use `@ts-expect-error` on core route files. The `router()` builder avoids this by catching errors internally.

### Plugin route registration

Plugin routes go through `config.routes(app, kernel)` on the TOP-LEVEL app (not the `/api` sub-router). The OpenAPI spec is served from the top-level app via `app.doc("/api/doc")`. If you put `.doc()` on a sub-router, plugin routes won't appear in the spec.

### Rate limiter key generator

Uses `x-forwarded-for` header. In load tests from localhost, ALL requests share one rate limit bucket. Set `config.rateLimits` to high values (100000) for load testing. Production deployments behind a reverse proxy should set this header.

### CSRF middleware

`hono/csrf` checks the `Origin` header on POST/PATCH/PUT/DELETE requests. Tests must include `origin: BASE` header or they get blocked.

---

## 3. The `router()` Builder

### How it works

`router(tag, prefix)` creates a route group. The builder:
1. Prepends `/api` to the prefix automatically
2. Normalizes double slashes and trailing slashes
3. Auto-detects `{id}` path params and validates as UUID
4. Injects error responses (400, 401, 403, 404, 422) automatically
5. `.auth()` returns 401 if no actor, `.permission("scope")` returns 403 if missing
6. `.handler()` receives `{ input, params, query, actor, services, db, logger, raw }`
7. Return value auto-wrapped in `{ data: result }`
8. Errors auto-caught and mapped via `mapErrorToResponse`
9. POST defaults to 201, others to 200

### The trailing slash issue

`router("X", "/wishlist").get("/")` used to produce `/api/wishlist/` (with trailing slash). Hono treats `/api/wishlist` and `/api/wishlist/` as different routes. We fixed this: `.get("/")` now maps to the prefix without trailing slash. If you see 404s, check for trailing slash mismatches.

### PluginContext wiring

The `router()` accepts an optional third argument: `PluginContext`. When provided, `{ services, db }` in the handler come from the plugin context, not from `c.get("kernel")`. Most plugin routes use closure-scoped services instead.

```typescript
// Pattern 1: services from closure (marketplace)
function buildRoutes(services: VendorServices) {
  const r = router("Vendors", "/marketplace/vendors");
  r.get("/").handler(async () => services.vendor.list());
}

// Pattern 2: db from PluginContext (wishlist)
function buildRoutes(ctx: PluginContext) {
  const { db } = ctx.database; // typed as PgDatabase
  const r = router("Wishlist", "/wishlist");
  r.get("/").handler(async () => db.select().from(wishlistItems));
}
```

### input typing

`RouteHandlerContext.input` is `unknown` because the builder can't infer the generic from `.input(schema)` at the type level. Use `z.infer<typeof Schema>` and cast:

```typescript
const AddSchema = z.object({ entityId: z.uuid() });
type AddInput = z.infer<typeof AddSchema>;

r.post("/").input(AddSchema).handler(async ({ input }) => {
  const body = input as AddInput; // safe — Zod validated
});
```

---

## 4. Better Auth Integration

### The double-cast

`auth/setup.ts` line 135: `return auth as unknown as AuthInstance`. This is intentional and unavoidable — Better Auth's plugin-extended return type doesn't structurally overlap with our simplified `AuthInstance` interface (e.g., `verifyApiKey` expects `{ body: { key } }` internally but we expose `{ key }`).

### Dev key

The hardcoded `dev-staff-key` is GONE. Replaced with config-driven `enableDevKey` + `devKey`. Both must be set. Default: disabled. The test config and app configs set it explicitly.

### Cookie prefix

Better Auth cookies are prefixed with `uc.` (not the default `better-auth.`). This is set in `auth/setup.ts` via `advanced.cookiePrefix`.

### Permission resolution

`resolvePermissions()` in `auth/middleware.ts` checks `session.session.activeOrganizationRole`. If no role, returns customer permissions. If role exists, looks up `config.auth.roles[role].permissions`. API keys fall back to `config.auth.apiKeys.defaultPermissions` (NOT a magic `ai_agent` role name — we fixed this).

---

## 5. Analytics System

### No adapter swap

`config.analytics.adapter` was REMOVED in RFC-009. Drizzle is always the analytics adapter. Cube.js is an optional *plugin* that adds `/api/cubejs/*` endpoints alongside (not replacing) the default analytics.

### Model naming

Everything was renamed: `CubeDefinition` → `AnalyticsModel`, `BUILTIN_CUBES` → `BUILTIN_ANALYTICS_MODELS`, `registerCube` → `registerModel`, `cubes.ts` → `models.ts`. Deprecated aliases exist in `types.ts` for one release cycle.

### Marketplace models

`MARKETPLACE_ANALYTICS_MODELS` (VendorOrders, VendorBalance, VendorReviews) are in `plugin-marketplace`, NOT in core. They're registered via the `analyticsModels` manifest slot.

### Scope enforcement

`AnalyticsScope` is REQUIRED on every query. `buildAnalyticsScope(actor)` is the only way to create one. Admin sees everything, vendor sees own data (parameterized WHERE), customer sees own data, public is blocked. Scope rules use `:vendorId` / `:customerId` placeholders — replaced with parameterized SQL values, NEVER string interpolation.

---

## 6. OpenAPI Spec

### Where it's served

`GET /api/doc` — JSON spec (from top-level `app.doc()` in `server.ts`)
`GET /api/reference` — Swagger UI (from sub-router in `rest/index.ts`)

### Why plugin routes appear

Plugin routes are registered on the top-level `app` via `config.routes(app, kernel)`. The `app.doc()` is also on the top-level app, so it captures both core sub-router routes AND plugin routes.

### z.any() → drizzle-zod

Response schemas were `z.any()` (showing `{}` in spec). We replaced them with `createSelectSchema(table)` from `drizzle-zod`. Schemas are in `schemas/responses.ts`. Use `dataResponse(schema, name)`, `dataArrayResponse()`, or `paginatedResponse()` helpers.

### z.uuid()

Use `z.uuid()` NOT `z.string().uuid()`. The latter is deprecated in Zod v4.

---

## 7. Testing Patterns

### UUID format in tests

Zod validates RFC4122 UUIDs. Zero-filled UUIDs like `00000000-0000-0000-0000-000000000099` FAIL validation (wrong version/variant bytes). Use `00000000-0000-4000-8000-000000000099` (version 4, variant 1).

### Integration test setup

Tests run against a live server. Always: `bun run setup` (reset DB + seed) → `bun run start` → `bun run test:all`. Tests are NOT idempotent — stock depletes across runs. Fresh DB required for reliable results.

### Rate limiting in tests

App configs set `rateLimits: { api: 10000, auth: 10000, checkout: 10000 }` to avoid 429s during test runs. Production should use defaults (100/10/5 per minute).

### The `api()` helper

```typescript
async function api(method, path, body?, opts?) {
  // Always include origin header (CSRF)
  // Always include x-api-key: dev-staff-key (auth)
  // Use { noAuth: true } to test unauthenticated paths
}
```

---

## 8. Things That Surprised Us

1. **PGlite type compatibility** — `PgliteDatabase` and `PostgresJsDatabase` don't overlap. The fix was using `PgDatabase<PgQueryResultHKT>` which both extend.

2. **OpenAPIHono sub-router isolation** — `.doc()` on a sub-router only collects routes registered on THAT router. Plugin routes registered on the parent app are invisible to the sub-router's spec.

3. **Zod v4 `z.record()`** — Requires TWO arguments: `z.record(z.string(), z.unknown())`. One-argument form `z.record(z.unknown())` throws at compile time.

4. **`hono-rate-limiter` at load** — 10000 req/min = 166/sec. At 100 VUs doing ~400 req/s, you STILL hit the limit. Set to 100000+ for load testing.

5. **Checkout compensation chain** — Reserve inventory → capture payment → create order → fulfill. If any step fails, the chain compensates in reverse. The `runCompensationChain` executor handles this. Don't bypass it.

6. **`createSelectSchema()` import** — It's `from "drizzle-zod"` (separate package), NOT `from "drizzle-orm/zod"` (doesn't exist in our version).

7. **Plugin permission scopes** — Declared in manifest but NOT validated at boot time. A typo in `.permission("markteplace:admin")` silently grants nothing. Future work: boot-time validation.

8. **Actor userId vs Customer UUID** — Better Auth `actor.userId` is a string ID from the `user` table. Customer data uses a UUID from the `customers` table. `resolveCustomerActor()` in `customer-portal.ts` bridges the two.

---

## 9. File Map (Where to Find Things)

| What | Where |
|------|-------|
| Route builder (`router()`) | `packages/core/src/interfaces/rest/router.ts` |
| OpenAPI schemas | `packages/core/src/interfaces/rest/schemas/` |
| Response types (drizzle-zod) | `packages/core/src/interfaces/rest/schemas/responses.ts` |
| Auth middleware | `packages/core/src/auth/middleware.ts` |
| Auth setup (Better Auth) | `packages/core/src/auth/setup.ts` |
| Analytics models (core) | `packages/core/src/modules/analytics/models.ts` |
| Analytics adapter (Drizzle) | `packages/core/src/modules/analytics/drizzle-adapter.ts` |
| Kernel (boot) | `packages/core/src/runtime/kernel.ts` |
| Server (Hono app) | `packages/core/src/runtime/server.ts` |
| Logger (Pino) | `packages/core/src/runtime/logger.ts` |
| Graceful shutdown | `packages/core/src/runtime/shutdown.ts` |
| Plugin manifest | `packages/core/src/kernel/plugin/manifest.ts` |
| Marketplace plugin | `packages/plugins/plugin-marketplace/src/` |
| Cube.js plugin | `packages/plugins/plugin-cubejs/src/` |
| POS plugin | `packages/plugins/plugin-pos/src/` |
| Wishlist plugin (DX reference) | `apps/store-example/src/plugins/wishlist-plugin.ts` |
| k6 load test | `apps/runvae/test/load/k6-load-test.js` |
| Wishlist E2E tests | `apps/store-example/test/wishlist.test.ts` |
| Integration tests | `apps/runvae/test/` |
| RFCs | `RFC-*.md` (root) |
| TODOs | `TODO.md`, `TODO-SDK-TYPED-CLIENT.md`, `TODO-SUPERLINKED-SEARCH-ADAPTER.md` |
| Documentation | `apps/docs/content/docs/` |
