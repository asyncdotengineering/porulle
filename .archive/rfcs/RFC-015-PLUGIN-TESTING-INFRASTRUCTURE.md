# RFC-015: Plugin Testing Infrastructure

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-16
- **Scope:** `packages/core/src/test-utils/`, plugin test consumers
- **Depends on:** PGlite (`@electric-sql/pglite`), `drizzle-kit/api` (programmatic `pushSchema`), Vitest
- **Estimated effort:** 2 engineering-days
- **Priority:** High --- every plugin author currently reimplements the same 120-line test boilerplate

---

## 1. Problem

Plugin developers must write 120+ lines of boilerplate before their first test assertion runs. Three independent gaps compound into this:

1. **Manual DDL duplication.** The PGlite test adapter reads hardcoded migration SQL files. Plugin tables are not in those files. Every plugin test hand-writes `CREATE TABLE IF NOT EXISTS` DDL that duplicates the Drizzle `pgTable` definition. The appointments plugin has 120 lines of raw SQL mirroring 8 tables already defined in `src/schema.ts`. If a column is added to the schema but omitted from the test DDL, the test silently operates on a stale table shape.

2. **No exported test app helper.** Production uses `OpenAPIHono` (see `server.ts` line 31). The `router()` builder produces `RouteConfig` objects registered via `OpenAPIHono.openapi()`. The core's own `createTestServer()` (which properly uses `OpenAPIHono`, injects test actor middleware, and mounts routes) is internal to `rest-api-test-utils.ts` and not exported. Plugin developers must independently discover that they need `OpenAPIHono`, wire the `x-test-actor` middleware, cast through `as never` for the env type, and call `config.routes(app, kernel)`.

3. **Untyped hook handlers.** `PluginHookRegistration.handler` is `(...args: unknown[]) => unknown`. Every plugin casts `args` to a hand-written structural type on every handler. If core changes the hook context shape, every plugin breaks at runtime with no TypeScript diagnostic.

---

## 2. Why It Is Hard Today

### How Production Boots

```
server.ts:
  const app = new OpenAPIHono<ServerEnv>()    // OpenAPIHono --- has .openapi()
  app.route("/api", createRestRoutes(kernel))  // mounts core routes
  config.routes(app, kernel)                   // mounts plugin routes via manifest.ts
                                               // manifest calls app.openapi() --- works
```

### How Core Tests Work

```
rest-api-test-utils.ts:
  const app = new Hono<ServerEnv>()            // plain Hono --- no .openapi()
  app.route("/api", createRestRoutes(kernel))   // createRestRoutes makes its own OpenAPIHono internally
  // config.routes is NEVER called             // plugin routes are not tested
```

Core tests use plain `Hono` because they only test core routes (which create their own `OpenAPIHono` sub-routers internally). They never call `config.routes()`, so they never hit the manifest's `app.openapi()` cast.

### How Plugin Tests Must Work

Plugin routes are registered through `config.routes(app, kernel)`, which calls `(app as OpenAPIHono).openapi(routeConfig, handler)` inside `manifest.ts`. This means `app` must be an `OpenAPIHono`. There is no way around this without changing `router()` or `manifest.ts`.

The fix is not to fight this --- it is to give plugin developers a helper that handles it, exactly like production does.

---

## 3. Solution

Three additions to `packages/core/src/test-utils/`, exported from `@unifiedcommerce/core`:

| Deliverable | What It Solves |
|-------------|----------------|
| `createPluginTestApp(plugin, overrides?)` | DDL duplication + OpenAPIHono + middleware + route registration --- in one call |
| `testAdminActor`, `testCustomerActor`, `testNoPermActor`, `jsonHeaders()` | Every plugin redefines the same 4 actor fixtures and header builder |
| `beforeHook<T>()`, `afterHook<T>()` | Untyped `args: unknown` cast in every hook handler |

Zero changes to `router.ts`, `manifest.ts`, or any core route file. Zero regression risk.

---

## 4. Pseudocode

### 4.1 createPluginTestApp

```
FUNCTION createPluginTestApp(plugin, configOverrides?):
    // 1. Build config with plugin applied
    config = await createTestConfig({ plugins: [plugin], ...configOverrides })

    // 2. Create kernel (boots PGlite by default, or real PG if adapter overridden)
    kernel = createKernel(config)

    // 3. Merge core schema + plugin schemas from config.customSchemas
    mergedSchema = buildSchema(config)

    // 4. Programmatic schema push via drizzle-kit/api
    //    Replaces 120 lines of hand-written DDL
    //    pushSchema diffs the live DB against pgTable definitions and generates CREATE TABLE DDL
    drizzleKitApi = createRequire(import.meta.url)("drizzle-kit/api")
    { apply } = await drizzleKitApi.pushSchema(mergedSchema, kernel.database.db)
    await apply()

    // 5. Create OpenAPIHono --- matching production server.ts
    //    This is why plugin routes work: manifest.ts calls app.openapi()
    app = new OpenAPIHono<TestAppEnv>()

    // 6. Test actor middleware --- same as createTestServer's x-test-actor pattern
    app.use("*", parseTestActorHeader)

    // 7. Register plugin routes --- same as production server.ts line 136
    config.routes(app, kernel)

    RETURN { app, kernel, db }
```

### 4.2 Programmatic Schema Push (replacing create-pglite-adapter.ts internals)

```
FUNCTION pushSchemaToTestDb(db, config):
    schema = buildSchema(config)                    // core + plugin tables
    drizzleKitApi = require("drizzle-kit/api")
    { apply } = await drizzleKitApi.pushSchema(schema, db)
    await apply()
```

This replaces:
- Hardcoded migration file paths (`0000_ambitious_vapor.sql`, `0001_overrated_warbird.sql`)
- Manual `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements
- Manual `CREATE TABLE` for post-migration tables
- All filesystem reads (`readFileSync`, `join`, `dirname`, `fileURLToPath`)

Verified working: `pushSchema` applied 18 DDL statements to create all 8 appointment tables in 710ms on PGlite.

### 4.3 Typed Hook Registration Helpers

```
FUNCTION beforeHook<TData>(key, handler):
    // handler signature: (args: { data: TData, operation, context: HookContext }) => TData
    // Returns PluginHookRegistration --- backward compatible
    RETURN { key, handler }

FUNCTION afterHook<TData>(key, handler):
    // handler signature: (args: { data: TData | null, result: TData, operation, context: HookContext }) => void
    RETURN { key, handler }
```

---

## 5. Code Blueprint

### 5.1 `packages/core/src/test-utils/create-plugin-test-app.ts`

```typescript
import { OpenAPIHono } from "@hono/zod-openapi";
import { createRequire } from "node:module";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { CommerceConfig, CommercePlugin } from "../../config/types";
import type { Actor } from "../../auth/types";
import { createTestConfig } from "./create-test-config";
import { createKernel, type Kernel } from "../../runtime/kernel";
import { buildSchema } from "../../kernel/database/migrate";

const require = createRequire(import.meta.url);

type DrizzleKitApi = {
  pushSchema(
    imports: Record<string, unknown>,
    drizzleInstance: PgDatabase<PgQueryResultHKT>,
    schemaFilters?: string[],
    tablesFilter?: string[],
  ): Promise<{
    hasDataLoss: boolean;
    warnings: string[];
    statementsToExecute: string[];
    apply: () => Promise<void>;
  }>;
};

export type TestAppEnv = {
  Variables: {
    actor: Actor | null;
  };
};

export interface PluginTestApp {
  app: OpenAPIHono<TestAppEnv>;
  kernel: Kernel;
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
}

export async function createPluginTestApp(
  plugin: CommercePlugin,
  configOverrides: Partial<CommerceConfig> = {},
): Promise<PluginTestApp> {
  const config = await createTestConfig({
    plugins: [plugin],
    ...configOverrides,
  });

  const kernel = createKernel(config);
  const mergedSchema = buildSchema(config);

  const drizzleKit = require("drizzle-kit/api") as DrizzleKitApi;
  const { apply } = await drizzleKit.pushSchema(
    mergedSchema,
    kernel.database.db as PgDatabase<PgQueryResultHKT>,
  );
  await apply();

  const app = new OpenAPIHono<TestAppEnv>();
  app.use("*", async (c, next) => {
    const header = c.req.header("x-test-actor");
    if (header) {
      try {
        c.set("actor", JSON.parse(header) as Actor);
      } catch { /* malformed JSON */ }
    }
    await next();
  });

  const routes = config.routes as
    | ((app: unknown, kernel: unknown) => void)
    | undefined;
  routes?.(app, kernel);

  return {
    app,
    kernel,
    db: kernel.database.db as PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  };
}
```

### 5.2 `packages/core/src/test-utils/test-actors.ts`

```typescript
import type { Actor } from "../../auth/types";

export const testAdminActor: Actor = {
  type: "user",
  userId: "test-admin-1",
  email: "admin@test.local",
  name: "Test Admin",
  vendorId: null,
  organizationId: null,
  role: "admin",
  permissions: ["*:*"],
};

export const testStaffActor: Actor = {
  type: "user",
  userId: "test-staff-1",
  email: "staff@test.local",
  name: "Test Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:read", "catalog:create", "catalog:update",
    "inventory:adjust", "orders:read", "orders:create", "orders:update",
  ],
};

export const testCustomerActor: Actor = {
  type: "user",
  userId: "test-customer-1",
  email: "customer@test.local",
  name: "Test Customer",
  vendorId: null,
  organizationId: null,
  role: "customer",
  permissions: ["catalog:read", "cart:create", "cart:read", "orders:read:own"],
};

export const testNoPermActor: Actor = {
  type: "user",
  userId: "test-noperm-1",
  email: "noperm@test.local",
  name: "No Permissions",
  vendorId: null,
  organizationId: null,
  role: "customer",
  permissions: [],
};

export function jsonHeaders(actor?: Actor): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (actor) headers["x-test-actor"] = JSON.stringify(actor);
  return headers;
}
```

### 5.3 `packages/core/src/test-utils/typed-hooks.ts`

```typescript
import type { PluginHookRegistration } from "../../kernel/plugin/manifest";
import type { HookContext, HookOperation } from "../../kernel/hooks/types";

export function beforeHook<TData>(
  key: string,
  handler: (args: {
    data: TData;
    operation: HookOperation;
    context: HookContext;
  }) => Promise<TData> | TData,
): PluginHookRegistration {
  return { key, handler: handler as PluginHookRegistration["handler"] };
}

export function afterHook<TData>(
  key: string,
  handler: (args: {
    data: TData | null;
    result: TData;
    operation: HookOperation;
    context: HookContext;
  }) => Promise<void> | void,
): PluginHookRegistration {
  return { key, handler: handler as PluginHookRegistration["handler"] };
}
```

### 5.4 Exports Addition to `packages/core/src/index.ts`

```typescript
export { createPluginTestApp, type PluginTestApp, type TestAppEnv } from "./test-utils/create-plugin-test-app";
export {
  testAdminActor, testStaffActor, testCustomerActor, testNoPermActor,
  jsonHeaders,
} from "./test-utils/test-actors";
export { beforeHook, afterHook } from "./test-utils/typed-hooks";
```

---

## 6. Before and After

### plugin-appointments test (before --- 215 lines in test-utils.ts)

```typescript
// 120 lines of hand-written DDL
const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "appointment_service_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  -- ... 100 more lines
`;

export async function createAppointmentTestApp(options?) {
  const kernel = await createTestKernel({ plugins: [appointmentPlugin(options ?? {})] });
  const db = kernel.database.db;
  // manually execute DDL statement by statement
  for (const statement of CREATE_TABLES_SQL.split(";")) {
    await (db as { execute(q: unknown): Promise<unknown> }).execute(sql.raw(trimmed));
  }
  // manually create OpenAPIHono
  const app = new OpenAPIHono();
  // manually wire test actor middleware with as-never casts
  app.use("*", async (c, next) => {
    const header = c.req.header("x-test-actor");
    if (header) {
      try { c.set("actor" as never, JSON.parse(header) as never); } catch {}
    }
    await next();
  });
  // manually register routes
  (kernel.config as { routes?: Function }).routes?.(app, kernel);
  return { app, kernel };
}

// 4 actor definitions, jsonHeaders helper ...
```

### plugin-appointments test (after --- test-utils.ts deleted)

```typescript
// booking-flow.test.ts
import { createPluginTestApp, jsonHeaders, testAdminActor, testCustomerActor } from "@unifiedcommerce/core";
import { appointmentPlugin } from "../src";

const { app } = await createPluginTestApp(appointmentPlugin());

const res = await app.request("http://localhost/api/appointments/services", {
  method: "POST",
  headers: jsonHeaders(testAdminActor),
  body: JSON.stringify({ name: "Haircut", slug: "haircut", durationMinutes: 30, priceCents: 3000 }),
});
expect(res.status).toBe(201);
```

---

## 7. Driver-Agnostic: PGlite or Real PostgreSQL

`createPluginTestApp` is not coupled to PGlite. `drizzle-kit/api`'s `pushSchema()` accepts `PgDatabase<any>` --- satisfied by every PostgreSQL Drizzle driver. When no `databaseAdapter` is supplied, `createTestConfig()` auto-provisions PGlite. When a real adapter is supplied, the same `pushSchema()` call works against the live database.

```typescript
// PGlite (default --- zero setup)
const { app } = await createPluginTestApp(appointmentPlugin());

// Real PostgreSQL (production parity)
const { app } = await createPluginTestApp(appointmentPlugin(), {
  databaseAdapter: postgresAdapter({ connectionString: process.env.TEST_DATABASE_URL }),
});
```

| Scenario | Driver | Rationale |
|----------|--------|-----------|
| Local dev, `bun test` | PGlite (default) | Zero setup, in-process, ~200ms boot |
| CI pipeline | PGlite (default) | No Docker dependency, parallelizable |
| Concurrency testing | Real PostgreSQL | PGlite is single-connection --- `FOR UPDATE` does not exercise real lock contention |
| Pre-release regression | Real PostgreSQL | Exact driver parity with production |

---

## 8. Performance (PGlite Path)

| Metric | Current (migration files) | Proposed (pushSchema) |
|--------|--------------------------|----------------------|
| Schema push (core, 25 tables) | ~800ms | ~600ms |
| Schema push (core + plugin, 33 tables) | N/A (manual DDL) | ~800ms |
| PGlite boot | ~200ms | ~200ms |
| Test isolation | TRUNCATE CASCADE | TRUNCATE CASCADE |

76 appointment tests currently run in 2.2s. No performance regression expected.

---

## 9. Implementation Order

| Step | What | Effort |
|------|------|--------|
| 1 | `typed-hooks.ts` + exports | 2 hours |
| 2 | `test-actors.ts` + exports | 1 hour |
| 3 | `create-plugin-test-app.ts` + exports | 4 hours |
| 4 | Refactor `create-pglite-adapter.ts` to use `pushSchema` | 3 hours |
| 5 | Migrate `plugin-appointments` tests | 1 hour |
| 6 | Migrate `plugin-marketplace` tests | 1 hour |
| 7 | Update docs (testing guide + build-a-plugin tutorial) | 3 hours |
| **Total** | | **~15 hours (2 days)** |

---

## 10. Success Criteria

- [ ] `createPluginTestApp(plugin)` boots database, pushes merged schema, mounts middleware, registers routes --- one call
- [ ] Zero hand-written DDL in any plugin test file
- [ ] `testAdminActor`, `testCustomerActor`, `testNoPermActor`, `jsonHeaders()` exported from `@unifiedcommerce/core`
- [ ] `beforeHook<T>()` / `afterHook<T>()` provide autocomplete on `context.jobs`, `context.logger`
- [ ] `create-pglite-adapter.ts` uses `drizzle-kit/api` `pushSchema()` --- no migration file reads
- [ ] `plugin-appointments` tests pass with new helpers (delete `test/test-utils.ts`)
- [ ] `plugin-marketplace` tests pass with `createPluginTestApp`
- [ ] All existing 598 core tests pass (no regressions)

---

## 11. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `drizzle-kit/api` changes signature | Low (stable since 0.24.2, we are on 0.31.9) | High | Wrap in our own function. Pin version. |
| ESM/CJS interop with `createRequire` in Bun | Low (Bun 1.3+ supports it) | Medium | Test in CI. Fallback to `generateDrizzleJson` + `generateMigration`. |
| Typed hooks break existing handlers | None | None | `beforeHook<T>()` returns `PluginHookRegistration`. Existing `{ key, handler }` literals unchanged. |

---

## 12. References

- `drizzle-kit/api` source: [drizzle-kit/src/api.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/src/api.ts)
- Programmatic push discussion: [drizzle-team/drizzle-orm#4373](https://github.com/drizzle-team/drizzle-orm/discussions/4373)
- PGlite + Vitest pattern: [drizzle-team/drizzle-orm#4205](https://github.com/drizzle-team/drizzle-orm/issues/4205)
- PGlite snapshot optimization: [nikolamilovic.com](https://nikolamilovic.com/posts/fun-sane-node-tdd-postgres-pglite-drizzle-vitest/)
