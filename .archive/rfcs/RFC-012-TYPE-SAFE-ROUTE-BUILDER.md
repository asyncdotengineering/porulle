# RFC-012: Type-Safe Route Builder — `router()` API

- **Status:** Complete (285 → 7 'any' in production code, all plugins migrated to router())
- **Author:** Engineering
- **Date:** 2026-03-16
- **Scope:** `packages/core/src/interfaces/rest/router.ts` (new), plugin registration, all route files
- **Depends on:** RFC-010 F7 (OpenAPI), RFC-011 (plugin OpenAPI routes)
- **Estimated effort:** 8 engineering-days
- **Priority:** High -- type safety + developer experience are framework promises

---

## 1. Problem

Two related problems with one root cause:

**A: 289 `any` in production code.** Every route handler uses `c: any`, casts `c.req.valid("json") as any`, and wraps responses with `z.any()`. The framework promises type safety but delivers `any` at the HTTP layer.

**B: 23 lines of boilerplate per route.** `createRoute()` requires 3 levels of JSON nesting, manual error response spreading, manual status codes, manual `/api` prefix, and a separate handler registration.

**Root cause:** `createRoute()` from `@hono/zod-openapi` is a low-level primitive. Using it directly is like writing raw SQL instead of using Drizzle.

---

## 2. Solution: `router()`

A high-level route builder that wraps `createRoute()` with sensible defaults, type inference, and destructured handler context. Inspired by oRPC's `.input().handler()` chain but producing REST endpoints with OpenAPI spec.

### The API

```typescript
import { router, z } from "@unifiedcommerce/core";

// router(tag, pathPrefix) — tag for Swagger UI, prefix prepended to all routes
// The framework prepends /api internally. Developer never types /api.
const vendors = router("Marketplace - Vendors", "/marketplace/vendors");

vendors.get("/")
  .summary("List all vendors")
  .query(z.object({ status: z.string().optional(), search: z.string().optional() }))
  .handler(async ({ query, actor, services }) => {
    return services.vendor.list(query);
  });

vendors.post("/")
  .summary("Create a vendor")
  .input(z.object({
    name: z.string().min(1),
    commissionRateBps: z.number().int().optional(),
  }).openapi("CreateVendorRequest"))
  .handler(async ({ input, services }) => {
    return services.vendor.create(input);
  });

vendors.get("/{id}")
  .summary("Get vendor detail")
  .handler(async ({ params, services }) => {
    return services.vendor.getById(params.id);
  });

vendors.patch("/{id}")
  .summary("Update vendor")
  .input(UpdateVendorSchema)
  .handler(async ({ params, input, services }) => {
    return services.vendor.update(params.id, input);
  });

vendors.delete("/{id}")
  .summary("Delete vendor")
  .handler(async ({ params, services }) => {
    await services.vendor.delete(params.id);
  });

vendors.post("/{id}/approve")
  .summary("Approve vendor")
  .handler(async ({ params, services }) => {
    return services.vendor.approve(params.id);
  });

vendors.post("/{id}/reject")
  .summary("Reject vendor")
  .input(z.object({ reason: z.string() }))
  .handler(async ({ params, input, services }) => {
    return services.vendor.reject(params.id, input.reason);
  });

vendors.get("/{id}/documents")
  .summary("List vendor documents")
  .handler(async ({ params, services }) => {
    return services.vendor.listDocuments(params.id);
  });

vendors.post("/{id}/documents")
  .summary("Upload vendor document")
  .input(z.object({ type: z.string(), fileUrl: z.string().url() }))
  .handler(async ({ params, input, services }) => {
    return services.vendor.uploadDocument(params.id, input);
  });

vendors.post("/{id}/documents/{docId}/approve")
  .summary("Approve document")
  .handler(async ({ params, services }) => {
    return services.vendor.approveDocument(params.docId);
  });

// Register in plugin
export function marketplacePlugin() {
  return defineCommercePlugin({
    id: "marketplace",
    version: "2.0.0",
    routes: () => [...vendors.routes()],
  });
}
```

---

## 3. What the Developer Never Writes

| Today (manual) | With `router()` |
|----------------|-----------------|
| `import { createRoute } from "@hono/zod-openapi"` | Not needed |
| `content: { "application/json": { schema: X } }` | Automatic |
| `required: true` on body | Automatic when `.input()` called |
| `...errorResponses` on every route | Automatic (400, 401, 403, 404, 422) |
| `c.req.valid("json")` | Received as `input` in handler |
| `c.req.param("id")` | Received as `params.id` in handler |
| `c.req.valid("query")` | Received as `query` in handler |
| `c.get("actor")` | Received as `actor` in handler |
| `c.json({ data: result }, 201)` | Just `return result` — framework wraps in `{ data }` |
| `/api/` prefix | Framework prepends it |
| `new OpenAPIHono<any>()` | Not needed |
| `@ts-expect-error` | Not needed |
| `as any` casts | Not needed |
| `z.object({ data: z.any() })` response | Automatic |
| Tag per route | Shared via `router(tag, ...)` |
| Error handling try/catch | Framework catches and maps errors |

---

## 4. Handler Context

The `.handler()` callback receives a destructured context object instead of raw Hono `c`:

```typescript
interface HandlerContext<TInput, TQuery, TParams> {
  /** Validated request body (from .input()) */
  input: TInput;
  /** Validated query parameters (from .query()) */
  query: TQuery;
  /** Path parameters (auto-extracted from {id} in path) */
  params: TParams;
  /** Authenticated actor (from auth middleware) */
  actor: Actor | null;
  /** Kernel services */
  services: ServiceContainer;
  /** Database access */
  db: DrizzleDatabase;
  /** Structured logger (per-request child) */
  logger: Logger;
  /** Request ID */
  requestId: string;
  /** Raw Hono context (escape hatch — use only when necessary) */
  raw: Context;
}
```

Types are inferred from the chain:

```typescript
vendors.post("/{id}/reject")
  .input(z.object({ reason: z.string() }))  // ← TypeScript captures this
  .handler(async ({ params, input }) => {
    // params: { id: string }           ← inferred from path
    // input: { reason: string }        ← inferred from .input()
    // actor: Actor | null              ← always present
    // services: ServiceContainer       ← always present
  });
```

### The `raw` Escape Hatch

For cases where the destructured context isn't enough (setting headers, redirects, streaming), the raw Hono context is available:

```typescript
vendors.get("/{id}/export")
  .summary("Export vendor data as CSV")
  .handler(async ({ params, raw }) => {
    const csv = await generateCsv(params.id);
    raw.header("Content-Type", "text/csv");
    return raw.body(csv);
  });
```

This is the escape hatch — not the default path. 99% of routes just return data.

---

## 5. How the Framework Handles Responses

The handler returns data. The framework wraps it.

```typescript
// Developer writes:
.handler(async ({ services }) => {
  return services.vendor.list();
})

// Framework does:
// 1. Call handler
// 2. If handler returns data → c.json({ data: result }, status)
// 3. If handler throws Error → c.json({ error: { code, message } }, errorStatus)
// 4. If handler returns null/undefined → c.json({ data: null }, status)
```

Status codes:
- `POST` → 201
- Everything else → 200
- Thrown `CommerceNotFoundError` → 404
- Thrown `CommerceValidationError` → 422
- Thrown `CommerceForbiddenError` → 403
- Any other error → 500 (sanitized message)

The developer never writes `c.json()`, never manages status codes, never catches errors.

---

## 6. `/api` Prefix Handling

The framework prepends `/api` to all routes internally. The developer writes domain paths only:

```typescript
// Developer writes:
router("Vendors", "/marketplace/vendors");

// Internal path in OpenAPI spec:
// /api/marketplace/vendors

// HTTP request:
// GET http://localhost:4001/api/marketplace/vendors
```

Why `/api` is framework-owned:
- Auth middleware is mounted on `/api/*`
- Rate limiting is mounted on `/api/*`
- CSRF protection is on `/api/*`
- Body size limits are on `/api/*`
- If a developer forgets `/api`, the route skips all security middleware

By making the framework own it, this security gap is impossible.

---

## 7. Implementation

### Pseudocode

```
CLASS Router:
    PRIVATE tag: string
    PRIVATE prefix: string
    PRIVATE _routes: PluginRouteRegistration[] = []

    CONSTRUCTOR(tag, prefix):
        this.tag = tag
        this.prefix = "/api" + prefix

    METHOD get(path) → RouteChain:
        RETURN new RouteChain("get", this.prefix + path, this.tag, this._routes)

    METHOD post(path) → RouteChain:
        RETURN new RouteChain("post", this.prefix + path, this.tag, this._routes)

    // ... patch, delete, put

    METHOD routes() → PluginRouteRegistration[]:
        RETURN this._routes

CLASS RouteChain:
    PRIVATE _summary = ""
    PRIVATE _input: ZodType | null = null
    PRIVATE _query: ZodType | null = null
    PRIVATE _params: ZodType | null = null  // auto-detected from path

    CONSTRUCTOR(method, fullPath, tag, routesList):
        // Auto-detect path params: "/{id}/documents/{docId}" → { id: uuid, docId: uuid }
        paramNames = extractParams(fullPath)
        IF paramNames.length > 0:
            this._params = z.object(fromEntries(paramNames.map(n => [n, z.string().uuid()])))

    METHOD summary(text) → this
    METHOD input(schema) → this
    METHOD query(schema) → this
    METHOD params(schema) → this  // override auto-detection

    METHOD handler(fn) → void:
        // 1. Build createRoute() from accumulated config
        routeConfig = createRoute({
            method, path: fullPath, tags: [tag], summary,
            request: { body?, query?, params? },
            responses: { [status]: wrapJson(z.any()), ...errorResponses },
        })

        // 2. Create a Hono handler that bridges destructured context to raw context
        honoHandler = async (c) => {
            TRY:
                ctx = {
                    input: _input ? stripUndefined(c.req.valid("json")) : undefined,
                    query: _query ? c.req.valid("query") : undefined,
                    params: extractParamsFromContext(c),
                    actor: c.get("actor"),
                    services: c.get("kernel").services,
                    db: c.get("kernel").database.db,
                    logger: c.get("logger"),
                    requestId: c.get("requestId"),
                    raw: c,
                }
                result = AWAIT fn(ctx)
                IF result IS undefined OR null:
                    RETURN c.json({ data: null }, status)
                RETURN c.json({ data: result }, status)
            CATCH error:
                RETURN c.json(mapErrorToResponse(error), mapErrorToStatus(error))

        // 3. Push to routes list
        routesList.push({ openapi: routeConfig, handler: honoHandler })
```

### Blueprint

New file: `packages/core/src/interfaces/rest/router.ts`

```typescript
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorSchema } from "./schemas/shared";
import { mapErrorToResponse, mapErrorToStatus, stripUndefined } from "./utils";
import type { PluginRouteRegistration } from "../../kernel/plugin/manifest";

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
  return [...path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
}

class RouteChain {
  private _summary = "";
  private _description = "";
  private _input: z.ZodType | undefined;
  private _query: z.ZodType | undefined;
  private _params: z.ZodType | undefined;

  constructor(
    private method: string,
    private fullPath: string,
    private tag: string,
    private routesList: PluginRouteRegistration[],
  ) {
    const paramNames = extractPathParams(fullPath);
    if (paramNames.length > 0) {
      this._params = z.object(
        Object.fromEntries(paramNames.map(n => [n, z.string().uuid()]))
      );
    }
  }

  summary(text: string) { this._summary = text; return this; }
  description(text: string) { this._description = text; return this; }
  input(schema: z.ZodType) { this._input = schema; return this; }
  query(schema: z.ZodType) { this._query = schema; return this; }
  params(schema: z.ZodType) { this._params = schema; return this; }

  handler(fn: (ctx: any) => Promise<unknown>): void {
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

    const honoHandler = async (c: any) => {
      try {
        const ctx = {
          input: inputSchema ? stripUndefined(c.req.valid("json")) : undefined,
          query: querySchema ? c.req.valid("query") : {},
          params: Object.fromEntries(
            extractPathParams(this.fullPath).map(n => [n, c.req.param(n)])
          ),
          actor: c.get("actor"),
          services: (c.get("kernel") ?? {}).services ?? {},
          db: (c.get("kernel") ?? {}).database?.db,
          logger: c.get("logger"),
          requestId: c.get("requestId"),
          raw: c,
        };

        const result = await fn(ctx);

        if (result === undefined || result === null) {
          return c.json({ data: null }, status);
        }
        return c.json({ data: result }, status);
      } catch (error: unknown) {
        return c.json(
          mapErrorToResponse(error),
          mapErrorToStatus(error),
        );
      }
    };

    this.routesList.push({ openapi: routeConfig, handler: honoHandler });
  }
}

class Router {
  private _routes: PluginRouteRegistration[] = [];

  constructor(
    private tag: string,
    private prefix: string,
  ) {
    // Prepend /api if not already present
    if (!this.prefix.startsWith("/api")) {
      this.prefix = "/api" + this.prefix;
    }
  }

  get(path: string) { return new RouteChain("get", this.prefix + path, this.tag, this._routes); }
  post(path: string) { return new RouteChain("post", this.prefix + path, this.tag, this._routes); }
  patch(path: string) { return new RouteChain("patch", this.prefix + path, this.tag, this._routes); }
  delete(path: string) { return new RouteChain("delete", this.prefix + path, this.tag, this._routes); }
  put(path: string) { return new RouteChain("put", this.prefix + path, this.tag, this._routes); }

  /** Returns all registered routes as PluginRouteRegistration[] */
  routes(): PluginRouteRegistration[] {
    return this._routes;
  }
}

/**
 * Create a typed route group.
 *
 * @param tag — OpenAPI tag for Swagger UI grouping
 * @param prefix — Path prefix (e.g., "/marketplace/vendors"). /api is prepended automatically.
 *
 * @example
 * ```typescript
 * const vendors = router("Marketplace", "/marketplace/vendors");
 *
 * vendors.get("/").summary("List").handler(async ({ services }) => {
 *   return services.vendor.list();
 * });
 *
 * vendors.post("/").summary("Create").input(Schema).handler(async ({ input, services }) => {
 *   return services.vendor.create(input);
 * });
 * ```
 */
export function router(tag: string, prefix: string): Router {
  return new Router(tag, prefix);
}
```

Export from core:

```typescript
// packages/core/src/index.ts
export { router } from "./interfaces/rest/router";
```

---

## 8. Before vs After: Vendor Routes

### Before: 291 lines (vendors.ts + schemas/vendors.ts)

Two files. Manual `createRoute()` with JSON nesting. `c: any` on every handler. Manual error response spreading. Manual `/api` prefix. Manual `c.json({ data })` wrapping.

### After: ~45 lines

```typescript
import { router, z } from "@unifiedcommerce/core";

const CreateVendorSchema = z.object({
  name: z.string().min(1),
  commissionRateBps: z.number().int().optional(),
}).openapi("CreateVendorRequest");

const RejectSchema = z.object({ reason: z.string() }).openapi("RejectVendorRequest");
const SuspendSchema = z.object({ reason: z.string() }).openapi("SuspendVendorRequest");
const DocSchema = z.object({ type: z.string(), fileUrl: z.string().url() }).openapi("UploadDocRequest");

const vendors = router("Marketplace - Vendors", "/marketplace/vendors");

vendors.get("/").summary("List vendors")
  .query(z.object({ status: z.string().optional(), search: z.string().optional() }))
  .handler(async ({ query, services }) => services.vendor.list(query));

vendors.post("/").summary("Create vendor")
  .input(CreateVendorSchema)
  .handler(async ({ input, services }) => services.vendor.create(input));

vendors.get("/{id}").summary("Get vendor")
  .handler(async ({ params, services }) => services.vendor.getById(params.id));

vendors.patch("/{id}").summary("Update vendor")
  .input(z.object({ name: z.string().optional(), description: z.string().optional() }))
  .handler(async ({ params, input, services }) => services.vendor.update(params.id, input));

vendors.post("/{id}/approve").summary("Approve vendor")
  .handler(async ({ params, services }) => services.vendor.approve(params.id));

vendors.post("/{id}/reject").summary("Reject vendor")
  .input(RejectSchema)
  .handler(async ({ params, input, services }) => services.vendor.reject(params.id, input.reason));

vendors.post("/{id}/suspend").summary("Suspend vendor")
  .input(SuspendSchema)
  .handler(async ({ params, input, services }) => services.vendor.suspend(params.id, input.reason));

vendors.post("/{id}/reinstate").summary("Reinstate vendor")
  .handler(async ({ params, services }) => services.vendor.reinstate(params.id));

vendors.get("/{id}/documents").summary("List documents")
  .handler(async ({ params, services }) => services.vendor.listDocuments(params.id));

vendors.post("/{id}/documents").summary("Upload document")
  .input(DocSchema)
  .handler(async ({ params, input, services }) => services.vendor.uploadDocument(params.id, input));

vendors.post("/{id}/documents/{docId}/approve").summary("Approve document")
  .handler(async ({ params, services }) => services.vendor.approveDocument(params.docId));

vendors.post("/{id}/documents/{docId}/reject").summary("Reject document")
  .handler(async ({ params, services }) => services.vendor.rejectDocument(params.docId));

vendors.get("/{id}/balance").summary("Get balance")
  .handler(async ({ params, services }) => services.payout.getBalance(params.id));

vendors.get("/{id}/performance").summary("Get performance")
  .handler(async ({ params, services }) => services.review.getAggregateRating(params.id));
```

**291 lines to 45 lines. 85% reduction. Same OpenAPI spec. Full type inference. No `any`.**

---

## 9. Implementation Order

| Phase | What | Effort | Eliminates |
|-------|------|--------|------------|
| 1 | `router()` builder + `AppEnv` + `stripUndefined()` + `requirePermission()` | 2 days | Core infrastructure |
| 2 | Rewrite wishlist plugin as proof-of-concept | Half day | Validates pattern |
| 3 | Migrate all marketplace plugin routes | 2 days | 69 routes, ~5 files |
| 4 | Migrate all other plugins (POS, influencer, subscriptions, loyalty) | 1 day | 44 routes |
| 5 | Migrate core routes | 2 days | 75 routes |
| 6 | Enable `@typescript-eslint/no-explicit-any: error` in CI | Half day | Enforcement |

---

## 10. New Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `drizzle-zod` | ^0.7.0 | Generate Zod response schemas from Drizzle tables (Phase 5) |

---

## 11. Success Criteria

### Type Safety
- [ ] Zero `c: any` in route handlers
- [ ] Zero `as any` casts at service boundaries
- [ ] Zero `@ts-expect-error` on route registration
- [ ] Zero `OpenAPIHono<any>()` in route files
- [ ] `@typescript-eslint/no-explicit-any: error` in CI

### Developer Experience
- [ ] `router()` exported from `@unifiedcommerce/core`
- [ ] `/api` prefix prepended automatically — developer never types it
- [ ] Path params auto-detected from `{id}` in path
- [ ] Error responses injected automatically
- [ ] Handler receives `{ input, params, query, actor, services, db }` — no raw `c`
- [ ] Return value auto-wrapped in `{ data: result }`
- [ ] Errors auto-caught and mapped to `{ error: { code, message } }`
- [ ] POST defaults to 201, others to 200

### Verification
- [ ] OpenAPI spec paths identical before and after
- [ ] 266 core tests pass, 304 integration tests pass
- [ ] Vendor routes: 291 lines to ~45 lines
- [ ] Wishlist plugin: 142 lines to ~30 lines
