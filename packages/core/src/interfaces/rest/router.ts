/**
 * Type-safe route builder for UnifiedCommerce plugins.
 *
 * Wraps @hono/zod-openapi's createRoute() with sensible defaults:
 * - /api prefix prepended automatically
 * - Error responses (400, 401, 403, 404, 422) injected
 * - Path params auto-detected from {id} patterns
 * - POST defaults to 201, others to 200
 * - .auth() enforces login, .permission() enforces specific scope
 * - Handler receives { input, params, query, actor, services, db, logger }
 * - Return value auto-wrapped in { data: result }
 * - Errors auto-caught and mapped to { error: { code, message } }
 *
 * @example
 * ```typescript
 * import { router, z } from "@porulle/core";
 *
 * const vendors = router("Vendors", "/marketplace/vendors");
 *
 * vendors.get("/").summary("List").auth().handler(async ({ actor, services }) => {
 *   return services.vendor.list();
 * });
 *
 * vendors.post("/").summary("Create").permission("marketplace:admin").input(Schema)
 *   .handler(async ({ input, services }) => services.vendor.create(input));
 * ```
 */

import { createRoute, z } from "@hono/zod-openapi";
import { ErrorSchema } from "./schemas/shared.js";
import { mapErrorToResponse, mapErrorToStatus } from "./utils.js";
import type { PluginRouteRegistration } from "../../kernel/plugin/manifest.js";
import { createScopedDb } from "../../kernel/database/scoped-db.js";
import { resolveOrgId } from "../../auth/org.js";

// ─── Shared OpenAPI Error Responses ──────────────────────────────────────────

const errorResponses = {
  400: { content: { "application/json": { schema: ErrorSchema } }, description: "Bad request." },
  401: { content: { "application/json": { schema: ErrorSchema } }, description: "Unauthorized." },
  403: { content: { "application/json": { schema: ErrorSchema } }, description: "Forbidden." },
  404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found." },
  422: { content: { "application/json": { schema: ErrorSchema } }, description: "Validation error." },
} as const;

function wrapJson(schema: z.ZodType) {
  return { content: { "application/json": { schema } }, description: "Success" };
}

function extractPathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

// ─── Handler Context ─────────────────────────────────────────────────────────

export interface RouteHandlerContext {
  /** Validated request body (from .input()). Undefined if no .input() was called. */
  input: unknown;
  /** Validated query parameters (from .query()). Empty object if no .query(). */
  query: Record<string, unknown>;
  /** Path parameters, auto-extracted from {id} segments. */
  params: Record<string, string>;
  /** Authenticated actor. Guaranteed non-null if .auth() or .permission() was called. */
  actor: { userId: string; role: string; permissions: string[]; vendorId?: string | null; [key: string]: unknown } | null;
  /** Resolved organization ID. Derived from actor.organizationId, falls back to DEFAULT_ORG_ID. */
  orgId: string;
  /** Kernel services (orders, cart, inventory, etc.) */
  services: Record<string, unknown>;
  /** Drizzle database instance */
  db: unknown;
  /** Per-request structured logger */
  logger: unknown;
  /** Request ID */
  requestId: string;
  /** Raw Hono context (escape hatch) */
  raw: unknown;
}

// ─── Route Chain ─────────────────────────────────────────────────────────────

class RouteChain {
  private _summary = "";
  private _description = "";
  private _input: z.ZodType | undefined;
  private _query: z.ZodType | undefined;
  private _params: z.ZodType | undefined;
  private _requireAuth = false;
  private _requiredPermission: string | undefined;
  constructor(
    private method: string,
    private fullPath: string,
    private tag: string,
    private routesList: PluginRouteRegistration[],
    private pluginCtx?: { services: Record<string, unknown>; db: unknown },
  ) {
    const paramNames = extractPathParams(fullPath);
    if (paramNames.length > 0) {
      this._params = z.object(
        Object.fromEntries(paramNames.map((n) => [n, z.uuid()])),
      );
    }
  }

  /** Set the OpenAPI summary for this route. */
  summary(text: string) { this._summary = text; return this; }

  /** Set the OpenAPI description for this route. */
  description(text: string) { this._description = text; return this; }

  /** Set the request body schema. Only for POST/PATCH/PUT. */
  input(schema: z.ZodType) { this._input = schema; return this; }

  /** Set the query parameter schema. */
  query(schema: z.ZodType) { this._query = schema; return this; }

  /** Override the auto-detected path parameter schema. */
  params(schema: z.ZodType) { this._params = schema; return this; }

  /**
   * Require authentication. The handler's `actor` is guaranteed non-null.
   * Returns 401 if the request has no authenticated actor.
   */
  auth() { this._requireAuth = true; return this; }

  /**
   * Require a specific permission scope. Implies .auth().
   * Returns 401 if not authenticated, 403 if the actor lacks the permission.
   *
   * Permission scopes should be declared in the plugin's `permissions` manifest.
   * The wildcard `*:*` always passes.
   *
   * @example
   * ```typescript
   * vendors.post("/").permission("marketplace:admin").handler(...)
   * wishlist.post("/").permission("wishlist:write").handler(...)
   * ```
   */
  permission(scope: string) {
    this._requireAuth = true;
    this._requiredPermission = scope;
    return this;
  }

  /**
   * Register the handler for this route.
   *
   * The handler receives a context object with typed input, params, query,
   * actor, services, and db. Return data is auto-wrapped in { data: result }.
   * Thrown errors are auto-caught and mapped to { error: { code, message } }.
   */
  handler(fn: (ctx: RouteHandlerContext) => Promise<unknown>): void {
    const request: Record<string, unknown> = {};
    if (this._input) request.body = { ...wrapJson(this._input), required: true };
    if (this._query) request.query = this._query;
    if (this._params) request.params = this._params;

    const status = this.method === "post" ? 201 : 200;

    const routeConfig = createRoute({
      method: this.method as "get",
      path: this.fullPath,
      tags: [this.tag],
      summary: this._summary,
      ...(this._description ? { description: this._description } : {}),
      ...(Object.keys(request).length > 0 ? { request } : {}),
      responses: {
        [status]: wrapJson(z.object({ data: z.any() })),
        ...errorResponses,
      },
    });

    const inputSchema = this._input;
    const querySchema = this._query;
    const pathParams = extractPathParams(this.fullPath);
    const successStatus = status;
    const requireAuth = this._requireAuth;
    const requiredPermission = this._requiredPermission;
    const pluginCtx = this.pluginCtx;

    const honoHandler = async (c: unknown) => {
      const ctx = c as {
        req: {
          valid: (target: string) => unknown;
          param: (name: string) => string;
        };
        get: (key: string) => unknown;
        json: (data: unknown, status?: number) => unknown;
      };

      try {
        // ─── Auth + Permission Check ─────────────────────────────────
        // .permission() implies .auth() — both are enforced here.
        // Order: auth first (401), then permission (403).
        const actor = ctx.get("actor") as RouteHandlerContext["actor"];

        if ((requireAuth || requiredPermission) && !actor) {
          return ctx.json({ error: { code: "UNAUTHORIZED", message: "Authentication required." } }, 401);
        }

        if (requiredPermission) {
          const perms = actor?.permissions ?? [];
          if (!perms.includes(requiredPermission) && !perms.includes("*:*")) {
            return ctx.json({
              error: { code: "FORBIDDEN", message: `Permission '${requiredPermission}' is required.` },
            }, 403);
          }
        }

        // ─── Extract context ─────────────────────────────────────────
        const params: Record<string, string> = {};
        for (const name of pathParams) {
          params[name] = ctx.req.param(name);
        }

        // Use plugin context if provided (plugin routes), fallback to kernel on Hono context (core routes)
        const kernel = pluginCtx ?? (ctx.get("kernel") as {
          services?: Record<string, unknown>;
          db?: unknown;
        } | undefined);

        // Scope the database to the actor's organization.
        // Plugin route handlers receive a db that auto-filters queries
        // and auto-stamps inserts with the actor's organizationId.
        const rawDb = kernel?.db;
        const orgId = resolveOrgId(actor);
        const scopedDb = rawDb ? createScopedDb(rawDb as Record<string, unknown>, orgId) : rawDb;

        const handlerCtx: RouteHandlerContext = {
          input: inputSchema ? ctx.req.valid("json") : undefined,
          query: querySchema ? (ctx.req.valid("query") as Record<string, unknown>) : {},
          params,
          actor,
          orgId,
          services: kernel?.services ?? {},
          db: scopedDb,
          logger: ctx.get("logger"),
          requestId: (ctx.get("requestId") as string) ?? "",
          raw: c,
        };

        const result = await fn(handlerCtx);

        if (result === undefined || result === null) {
          return ctx.json({ data: null }, successStatus);
        }
        return ctx.json({ data: result }, successStatus);
      } catch (error: unknown) {
        try {
          return ctx.json(
            mapErrorToResponse(error),
            mapErrorToStatus(error) as number,
          );
        } catch {
          // Fallback if mapErrorToResponse/mapErrorToStatus themselves throw
          return ctx.json(
            { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
            500,
          );
        }
      }
    };

    this.routesList.push({ openapi: routeConfig, handler: honoHandler as (...args: unknown[]) => unknown });
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────

class RouterImpl {
  private _routes: PluginRouteRegistration[] = [];
  private _prefix: string;
  private _pluginCtx: { services: Record<string, unknown>; db: unknown } | undefined;

  constructor(
    private tag: string,
    prefix: string,
    pluginCtx?: { services?: Record<string, unknown>; database?: { db: unknown } },
  ) {
    // Normalize: ensure /api prefix, strip trailing slash
    let p = prefix.startsWith("/api") ? prefix : `/api${prefix}`;
    p = p.replace(/\/+$/, ""); // remove trailing slashes
    this._prefix = p;

    // If plugin context is provided, wire services + db for handler access
    if (pluginCtx) {
      this._pluginCtx = {
        services: pluginCtx.services ?? {},
        db: pluginCtx.database?.db,
      };
    }
  }

  /** @internal — used by RouteChain to wire plugin context into handlers */
  get pluginContext() { return this._pluginCtx; }

  private resolvePath(path: string): string {
    // "/" means "the resource root" → just the prefix, no trailing slash
    if (path === "/") return this._prefix;
    return (this._prefix + path).replace(/\/\/+/g, "/");
  }

  get(path: string) { return new RouteChain("get", this.resolvePath(path), this.tag, this._routes, this._pluginCtx); }
  post(path: string) { return new RouteChain("post", this.resolvePath(path), this.tag, this._routes, this._pluginCtx); }
  patch(path: string) { return new RouteChain("patch", this.resolvePath(path), this.tag, this._routes, this._pluginCtx); }
  delete(path: string) { return new RouteChain("delete", this.resolvePath(path), this.tag, this._routes, this._pluginCtx); }
  put(path: string) { return new RouteChain("put", this.resolvePath(path), this.tag, this._routes, this._pluginCtx); }

  /** Returns all registered routes as PluginRouteRegistration[] */
  routes(): PluginRouteRegistration[] { return this._routes; }
}

/**
 * Create a typed route group for plugin routes.
 *
 * @param tag — OpenAPI tag for Swagger UI grouping
 * @param prefix — Path prefix without /api (e.g., "/marketplace/vendors"). /api is prepended automatically.
 * @param ctx — Optional PluginContext. When provided, handler receives { services, db } from the plugin.
 *
 * @example
 * ```typescript
 * // In plugin routes callback:
 * routes: (ctx) => {
 *   const r = router("Vendors", "/marketplace/vendors", ctx);
 *   r.get("/").summary("List").handler(async ({ services }) => {
 *     return (services as VendorServices).vendor.list();
 *   });
 *   return r.routes();
 * }
 * ```
 */
export function router(tag: string, prefix: string, ctx?: { services?: Record<string, unknown>; database?: { db: unknown } }): RouterImpl {
  return new RouterImpl(tag, prefix, ctx);
}
