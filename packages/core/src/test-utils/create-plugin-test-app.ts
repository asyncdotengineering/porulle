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
import { createRequire } from "node:module";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { CommerceConfig, CommercePlugin } from "../config/types.js";
import type { Actor } from "../auth/types.js";
import { createTestConfig } from "./create-test-config.js";
import { createKernel } from "../runtime/kernel.js";
import type { Kernel } from "../runtime/kernel.js";
import { buildSchema } from "../kernel/database/migrate.js";
import { unwrapDb } from "../kernel/database/adapter.js";
import { ensureDefaultOrg } from "../auth/org.js";
import { mapErrorToStatus } from "../kernel/error-mapper.js";

// drizzle-kit/api uses CJS internally; createRequire provides ESM compat.
const require = createRequire(import.meta.url);

type DrizzleKitPushResult = {
  hasDataLoss: boolean;
  warnings: string[];
  statementsToExecute: string[];
  apply: () => Promise<void>;
};

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

  // 3. Merge core + plugin schemas
  const mergedSchema = buildSchema(config);

  // 4. Programmatic schema push via drizzle-kit/api
  //    Diffs current DB state against pgTable definitions, generates DDL, applies it.
  //    On fresh PGlite: creates all tables. On existing DB: creates only missing tables.
  const drizzleKit = require("drizzle-kit/api") as {
    pushSchema(
      imports: Record<string, unknown>,
      drizzleInstance: PgDatabase<PgQueryResultHKT>,
    ): Promise<DrizzleKitPushResult>;
  };
  const { apply } = await drizzleKit.pushSchema(
    mergedSchema,
    // drizzle-kit needs the native driver result shape; unwrap the normalized db.
    unwrapDb(kernel.database.db) as PgDatabase<PgQueryResultHKT>,
  );
  await apply();

  // Ensure the default organization exists for plugin tests
  await ensureDefaultOrg(kernel.database.db);

  // 5. Create OpenAPIHono --- matching production server.ts
  //    Plugin routes register via manifest.ts which calls app.openapi().
  const app = new OpenAPIHono<TestAppEnv>();

  // 6. Test actor middleware: parse x-test-actor header -> set on context
  app.use("*", async (c, next) => {
    const header = c.req.header("x-test-actor");
    if (header) {
      try {
        c.set("actor", JSON.parse(header) as Actor);
      } catch { /* malformed JSON --- fall through without actor */ }
    }
    await next();
  });

  // 7. Register plugin routes (deferred via config.routes)
  const routes = config.routes as
    | ((app: unknown, kernel: unknown) => void)
    | undefined;
  routes?.(app, kernel);

  // 8. Error handler matching production server.ts — maps CommerceError
  //    subclasses (CommerceForbiddenError, CommerceNotFoundError, etc.)
  //    to their proper HTTP status codes (403, 404, 409, 422, 503).
  //    Without this, route handlers that throw assertPermission() etc.
  //    surface as 500 in tests, masking real status assertions.
  app.onError((err, c) => {
    if (err instanceof Error && "code" in err && typeof (err as { code?: unknown }).code === "string") {
      const status = mapErrorToStatus(err);
      if (status !== 500) {
        const errorCode = (err as { code: string }).code;
        return c.json(
          { error: { code: errorCode, message: err.message } },
          status,
        );
      }
    }
    return c.json(
      { error: { code: "INTERNAL_ERROR", message: err.message } },
      500,
    );
  });

  return {
    app,
    kernel,
    db: kernel.database.db as PgDatabase<PgQueryResultHKT, Record<string, unknown>>,
  };
}
