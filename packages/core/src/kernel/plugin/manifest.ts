import type { Hono } from "hono";
import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import type { PluginDb } from "../database/plugin-types.js";
import type { DatabaseAdapter } from "../database/adapter.js";
import { resolveOrgId } from "../../auth/org.js";
import { createScopedDb } from "../database/scoped-db.js";
import {
  getPluginDatabaseScopeOrganizationId,
  runWithPluginDatabaseScope,
} from "../database/plugin-db-context.js";
import type { Kernel } from "../../runtime/kernel.js";
import type {
  CommerceConfig,
  CommercePlugin,
  PluginPermission,
} from "../../config/types.js";
import type { TaskDefinition } from "../jobs/types.js";

// ─── Plugin Logger ────────────────────────────────────────────────────

export interface PluginLogger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

// ─── Plugin Registration Types ────────────────────────────────────────

/**
 * Plugin route registration. Supports two modes:
 *
 * 1. Legacy: { method, path, handler } — works, but invisible to OpenAPI spec.
 * 2. OpenAPI: { openapi, handler } — validated by Zod, appears in /api/doc.
 *
 * Use mode 2 for any route that accepts a request body or returns structured data.
 * Mode 1 is acceptable for simple routes (health checks, redirects, file serving).
 */
export type PluginRouteRegistration =
  | { method: string; path: string; handler: (...args: unknown[]) => unknown }
  | { openapi: RouteConfig; handler: (...args: unknown[]) => unknown };

export interface PluginHookRegistration {
  key: string;
  handler: (...args: unknown[]) => unknown;
}

// ─── Plugin Context (available to routes at boot time) ───────

export interface PluginContext {
  config: CommerceConfig;
  services: Record<string, unknown>;
  database: {
    /** Tenant-scoped Drizzle handle (organization from the request actor). */
    db: PluginDb;
    /**
     * Raw Drizzle handle — bypasses tenant scoping. Emits a rate-limited deprecation
     * warning on each access (MT-4 escape hatch).
     */
    unscoped: PluginDb;
    transaction<T>(fn: (tx: PluginDb) => Promise<T>): Promise<T>;
  };
  logger: PluginLogger;
  /**
   * The Better Auth instance (issue #51) — lets plugins mint/revoke
   * credentials (e.g. per-shift API keys from a POS PIN login). Present when
   * routes are mounted by createServer; may be absent in bare-kernel setups,
   * so plugins must degrade gracefully. Typed loosely to avoid coupling every
   * plugin to Better Auth's generics — cast to the narrow surface you use.
   */
  auth?: unknown;
}

const UNSCOPED_WARN_COOLDOWN_MS = 60_000;
const UNSCOPED_WARN_EVERY_N = 100;

function createRateLimitedUnscopedAccessWarning(logger: PluginLogger): () => void {
  let lastWarnAt = 0;
  let accessCount = 0;
  return () => {
    accessCount += 1;
    const now = Date.now();
    if (accessCount % UNSCOPED_WARN_EVERY_N !== 0 && now - lastWarnAt < UNSCOPED_WARN_COOLDOWN_MS) {
      return;
    }
    lastWarnAt = now;
    logger.warn(
      "[plugin:database] PluginContext.database.unscoped is deprecated (MT-4 escape hatch); prefer ctx.database.db for tenant-scoped access.",
    );
  };
}

function buildPluginContextDatabase(
  rawDb: PluginDb,
  transactionFn: PluginContext["database"]["transaction"],
  commerceConfig: CommerceConfig,
  logger: PluginLogger,
): PluginContext["database"] {
  const orgGetter = () =>
    getPluginDatabaseScopeOrganizationId() ??
    resolveOrgId(null, undefined, commerceConfig);

  const scopedDb = createScopedDb(rawDb, orgGetter);
  const warnUnscoped = createRateLimitedUnscopedAccessWarning(logger);

  return {
    get db(): PluginDb {
      return scopedDb;
    },
    get unscoped(): PluginDb {
      warnUnscoped();
      return rawDb;
    },
    transaction: async <T>(fn: (tx: PluginDb) => Promise<T>): Promise<T> => {
      return transactionFn(async (tx) => {
        const scopedTx = createScopedDb(tx as PluginDb, orgGetter);
        return fn(scopedTx);
      });
    },
  };
}

// ─── Plugin Manifest (input to defineCommercePlugin) ──────────────────

export type { PluginPermission };

export interface CommercePluginManifest {
  id: string;
  version: string;
  /**
   * IDs of plugins that must be registered before this one.
   * If any required plugin is missing at registration time,
   * defineCommercePlugin will throw with a clear message.
   */
  requires?: string[];
  /**
   * Permission scopes this plugin introduces.
   * Used by admin UIs to build role editors, and validated at boot time
   * against .permission() calls in routes.
   */
  permissions?: PluginPermission[];
  /**
   * Returns Drizzle `pgTable` objects that this plugin needs.
   * These are collected into `config.customSchemas[]` and merged with core
   * schema by `buildSchema(config)`. Each key becomes a named export in the
   * merged schema; names must not collide with core table exports.
   */
  schema?: () => Record<string, unknown>;
  hooks?: () => PluginHookRegistration[];
  routes?: (ctx: PluginContext) => PluginRouteRegistration[];
  analyticsModels?: () => unknown[];
  jobs?: () => TaskDefinition[];
  /**
   * Named API-key scopes this plugin mints credentials under (issue #51),
   * merged into `config.auth.apiKeyScopes`. User-defined scopes with the
   * same name win.
   */
  apiKeyScopes?: () => Record<string, {
    prefix?: string;
    description?: string;
    permissions?: Record<string, string[]>;
    /** Expiry bounds in DAYS (fractions allowed — 1/24 = one hour). */
    keyExpiration?: { minExpiresIn?: number; maxExpiresIn?: number };
    /** Better Auth ownership model for keys minted under this scope. */
    references?: "user" | "organization";
    enableMetadata?: boolean;
  }>;
}

// ─── Plugin Dependency Tracking ──────────────────────────────────────
// Accumulates plugin IDs as they register during defineConfig().
// Reset at the start of each defineConfig() call.
export const _registeredPlugins = new Set<string>();

/** @internal — called by defineConfig() before applying plugins */
export function _resetRegisteredPlugins(): void {
  _registeredPlugins.clear();
}

/**
 * Converts a plugin manifest into a config transform function.
 *
 * - `schema` → pushed into `config.customSchemas`
 * - `hooks` → merged into `config.hooks` flat map
 * - `routes` → chained onto `config.routes` (evaluated at boot with kernel)
 * - `analyticsModels` → pushed into `config.analytics.models`
 */
export function defineCommercePlugin(
  manifest: CommercePluginManifest,
): CommercePlugin {
  return (config: CommerceConfig): CommerceConfig => {
    // ── Dependency check ───────────────────────────────────────────
    // In test/development, warn instead of throwing so plugins can be
    // tested in isolation via createPluginTestApp() without installing
    // all dependencies. In production, this is a hard error.
    if (manifest.requires) {
      for (const dep of manifest.requires) {
        if (!_registeredPlugins.has(dep)) {
          const msg = `Plugin "${manifest.id}" requires "${dep}" to be installed before it. Add ${dep}Plugin() before ${manifest.id}Plugin() in your config.plugins array.`;
          if (process.env.NODE_ENV === "production") {
            throw new Error(msg);
          }
          // Non-production: log warning but continue (allows isolated testing)
          console.warn(`[plugin:${manifest.id}] WARNING: ${msg}`);
        }
      }
    }
    _registeredPlugins.add(manifest.id);
    let result = { ...config };

    if (manifest.permissions?.length) {
      const withPlugin: PluginPermission[] = manifest.permissions.map((p) => ({
        ...p,
        pluginId: manifest.id,
      }));
      result = {
        ...result,
        pluginPermissions: [...(result.pluginPermissions ?? []), ...withPlugin],
      };
    }

    // 0. API-key scopes — merge into auth.apiKeyScopes (user config wins)
    if (manifest.apiKeyScopes) {
      const scopes = manifest.apiKeyScopes();
      result = {
        ...result,
        auth: {
          ...(result.auth ?? {}),
          apiKeyScopes: {
            ...scopes,
            ...(result.auth?.apiKeyScopes ?? {}),
          },
        },
      } as CommerceConfig;
    }

    // 1. Schema — push into customSchemas for kernel to register
    if (manifest.schema) {
      const schemas = manifest.schema();
      result = {
        ...result,
        customSchemas: [...(result.customSchemas ?? []), schemas],
      };
    }

    // 2. Hooks — merge into flat hooks map (kernel registers at boot)
    if (manifest.hooks) {
      const registrations = manifest.hooks();
      const hookMap: Record<string, Array<(...args: unknown[]) => unknown>> = {
        ...(result.hooks ?? {}),
      };
      for (const reg of registrations) {
        hookMap[reg.key] = [...(hookMap[reg.key] ?? []), reg.handler];
      }
      result = { ...result, hooks: hookMap };
    }

    // 3. Routes — chain onto config.routes (deferred: needs kernel at boot)
    if (manifest.routes) {
      const existingRoutes = result.routes;
      const pluginRoutes = manifest.routes;
      result = {
        ...result,
        routes: (app: Hono, kernel: Kernel, auth?: unknown) => {
          existingRoutes?.(app, kernel, auth as never);
          const k = kernel as {
            config: CommerceConfig;
            services: Record<string, unknown>;
            database: DatabaseAdapter;
            logger: PluginLogger;
          };
          // Narrow DatabaseAdapter<unknown> → PluginContext.database once here.
          // All plugin code receives typed PluginDb — no casts downstream.
          const regs = pluginRoutes({
            config: k.config,
            services: k.services,
            database: buildPluginContextDatabase(
              k.database.db as PluginDb,
              k.database.transaction as PluginContext["database"]["transaction"],
              k.config,
              k.logger,
            ),
            logger: k.logger,
            ...(auth !== undefined ? { auth } : {}),
          });
          for (const route of regs) {
            // ── Error boundary: wrap handler with plugin context ──
            const originalHandler = route.handler;
            const wrappedHandler = async (...args: unknown[]) => {
              const c = args[0] as { get?: (key: string) => unknown } | undefined;
              const actor = c?.get?.("actor");
              const orgId = resolveOrgId(actor, undefined, k.config);
              try {
                return await runWithPluginDatabaseScope(orgId, async () => {
                  const out = originalHandler(...args);
                  return await Promise.resolve(out);
                });
              } catch (err) {
                // Try to extract logger from Hono context
                const c = args[0] as Record<string, unknown>;
                const logger = (c?.get as Function)?.("logger") as { error: Function } | undefined;
                logger?.error?.(
                  { err, plugin: manifest.id },
                  `[plugin:${manifest.id}] route handler error`,
                );
                throw err; // re-throw so global handler still catches
              }
            };

            if ("openapi" in route) {
              // OpenAPI route: validated by Zod, appears in /api/doc
              // Hono type interop — OpenAPIHono.openapi() expects strict RouteConfig+Handler
              // generics that can't be statically resolved for dynamic plugin routes.
              // @ts-expect-error -- dynamic plugin routes cannot satisfy Hono's strict handler generics
              (app as OpenAPIHono).openapi(route.openapi, wrappedHandler);
            } else {
              // Legacy route: raw handler, invisible to OpenAPI spec.
              // Explicit dispatch avoids casting Hono to a Record.
              // Handler cast is a single `as any` (Hono's overloaded method
              // signatures can't unify with our generic handler shape).
              const h = wrappedHandler as any;
              switch (route.method.toLowerCase()) {
                case "get":     app.get(route.path, h); break;
                case "post":    app.post(route.path, h); break;
                case "put":     app.put(route.path, h); break;
                case "patch":   app.patch(route.path, h); break;
                case "delete":  app.delete(route.path, h); break;
                case "options": app.options(route.path, h); break;
                default:
                  console.warn(`[plugin:${manifest.id}] unsupported HTTP method "${route.method}" for ${route.path}`);
              }
            }
          }
        },
      };
    }

    // 4. Analytics models — push into config.analytics.models
    if (manifest.analyticsModels) {
      const models = manifest.analyticsModels();
      result = {
        ...result,
        analytics: {
          ...result.analytics,
          models: [...(result.analytics?.models ?? []), ...models],
        },
      };
    }

    if (manifest.jobs) {
      result = {
        ...result,
        jobs: {
          ...(result.jobs ?? {}),
          tasks: [...(result.jobs?.tasks ?? []), ...manifest.jobs()],
        },
      };
    }

    return result;
  };
}
