/**
 * One-call plugin E2E test setup.
 *
 * Boots a PGlite kernel (or real PG if overridden), programmatically pushes
 * the merged schema (core + plugin tables) via drizzle-kit/api, mounts the
 * test actor middleware on an OpenAPIHono instance, and registers all plugin
 * routes --- matching the production server.ts boot sequence.
 *
 * Usage:
 *   import { createPluginTestApp, jsonHeaders, testAdminActor } from "@porulle/core";
 *   const { app } = await createPluginTestApp(myPlugin());
 *   const res = await app.request("/api/my-route", {
 *     method: "POST",
 *     headers: jsonHeaders(testAdminActor),
 *     body: JSON.stringify({ ... }),
 *   });
 *   expect(res.status).toBe(201);
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { CommerceConfig, CommercePlugin } from "../config/types.js";
import type { Actor } from "../auth/types.js";
import { createTestConfig } from "./create-test-config.js";
import { createKernel } from "../runtime/kernel.js";
import type { Kernel } from "../runtime/kernel.js";
import { pushSchema } from "../kernel/database/migrate.js";
import { ensureDefaultOrg } from "../auth/org.js";
import { mapErrorToResponse } from "../kernel/error-mapper.js";
import { buildConfigRoutesKernel } from "../kernel/plugin/manifest.js";
import { createAuth, type AuthInstance } from "../auth/setup.js";
import { authMiddleware } from "../auth/middleware.js";



/**
 * Hono environment type for the test app. Declares the `actor` context
 * variable so c.set("actor", ...) / c.get("actor") are properly typed
 * without `as never` casts.
 */
export type TestAppEnv = {
  Variables: {
    actor: Actor | null;
  };
};

export interface PluginTestApp {
  /** OpenAPIHono instance with test actor middleware and all plugin routes registered. */
  app: OpenAPIHono<TestAppEnv>;
  /** The booted kernel with database, services, and config. */
  kernel: Kernel;
  /** Drizzle database instance for direct queries in test assertions. */
  db: PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
  /** The Better Auth instance passed to plugin routes (mint/verify API keys in tests). */
  auth: AuthInstance;
}

/**
 * Creates a fully-wired test application for plugin E2E testing.
 *
 * @param plugin - The plugin under test (e.g., `appointmentPlugin()`)
 * @param configOverrides - Optional config overrides. Pass `databaseAdapter`
 *   to use a real PostgreSQL instance instead of PGlite.
 */
export async function createPluginTestApp(
  plugin: CommercePlugin,
  configOverrides: Partial<CommerceConfig> = {},
): Promise<PluginTestApp> {
  // 1. Build config with plugin applied (PGlite auto-provisioned if no adapter)
  const config = await createTestConfig({
    plugins: [plugin],
    ...configOverrides,
  });

  // 2. Boot kernel (creates core services, hook registry)
  const kernel = createKernel(config);

  // 3. Create core + plugin tables (drizzle-kit diffs the live database and
  //    applies only the missing DDL).
  await pushSchema(kernel.database.db, config);

  // Ensure the default organization exists for plugin tests
  await ensureDefaultOrg(kernel.database.db);

  // 5. Create OpenAPIHono --- matching production server.ts
  //    Plugin routes register via manifest.ts which calls app.openapi().
  const app = new OpenAPIHono<TestAppEnv>();
  const auth = createAuth(kernel.database, config);

  // 6. Test actor middleware: parse x-test-actor header -> set on context.
  //    Requests without the header fall through to the real auth middleware,
  //    so API keys minted by plugins (issue #51) authenticate like production.
  app.use("*", async (c, next) => {
    const header = c.req.header("x-test-actor");
    if (header) {
      try {
        c.set("actor", JSON.parse(header) as Actor);
      } catch { /* malformed JSON --- fall through without actor */ }
    }
    await next();
  });
  app.use("*", async (c, next) => {
    if (c.get("actor")) return next();
    return authMiddleware(auth, config)(c as never, next);
  });

  // 7. Register plugin routes (deferred via config.routes) exactly as
  //    server.ts does: with the tenant-scoped route kernel and the auth instance.
  const routes = config.routes as
    | ((app: unknown, kernel: unknown, auth?: unknown) => void)
    | undefined;
  routes?.(app, buildConfigRoutesKernel(kernel), auth);

  // 8. The production error handler: CommerceError subclasses map to their
  //    status (403, 404, 409, 422, 503) instead of surfacing as 500.
  app.onError((err, c) => {
    const { body, status } = mapErrorToResponse(err, false);
    return c.json(body, status);
  });

  return {
    app,
    kernel,
    db: kernel.database.db as PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
    auth,
  };
}
