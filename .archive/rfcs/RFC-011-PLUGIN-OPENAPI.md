# RFC-011: Plugin Routes in OpenAPI Spec

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-15
- **Scope:** `packages/core/src/kernel/plugin/manifest.ts`, all plugin route files
- **Depends on:** RFC-010 F7 (OpenAPI foundation in core)
- **Estimated effort:** 1-2 days

---

## 1. Problem

Plugin routes are invisible to the OpenAPI spec. The `PluginRouteRegistration` type uses `{ method, path, handler }` and the manifest registration calls `router[method](path, handler)` -- the raw Hono pattern that bypasses OpenAPIHono's spec generation.

Result: `GET /api/doc` shows 16 core routes but zero plugin routes. The marketplace plugin alone has 69 routes, POS has 9, loyalty 3, subscriptions 5, influencer 14 -- 113 total routes that are undocumented.

## 2. Solution

Change the manifest route registration to use `OpenAPIHono.openapi()`. Plugin routes that provide a `createRoute()` definition appear in the spec. The route handler receives validated, typed input.

Since there are no external developers, this is a clean break -- no backwards compatibility needed.

## 3. Implementation

### Step 1: Update PluginRouteRegistration type

```typescript
// manifest.ts
import type { RouteConfig } from "@hono/zod-openapi";

export type PluginRouteRegistration =
  | { method: string; path: string; handler: (...args: unknown[]) => unknown }
  | { openapi: RouteConfig; handler: (...args: unknown[]) => unknown };
```

Two modes: legacy `{ method, path, handler }` for quick routes with no body, and `{ openapi, handler }` for documented routes. Both work; only the openapi routes appear in the spec.

### Step 2: Update manifest registration logic

```typescript
for (const route of regs) {
  if ("openapi" in route) {
    (app as OpenAPIHono).openapi(route.openapi, route.handler as any);
  } else {
    const method = route.method.toLowerCase();
    (app as any)[method](route.path, route.handler);
  }
}
```

### Step 3: Convert plugin routes (prioritized)

| Plugin | Routes | Priority |
|--------|--------|----------|
| Marketplace vendors | 14 | P0 (core CRUD) |
| Marketplace vendor-portal | 18 | P0 (vendor-facing) |
| Marketplace disputes/returns/reviews | 14 | P1 |
| Marketplace commission | 5 | P1 |
| Marketplace payouts | 4 | P1 |
| Marketplace sub-orders | 3 | P1 |
| Marketplace B2B | 11 | P2 |
| POS | 9 | P2 |
| Influencer | 14 | P2 |
| Subscriptions | 5 | P2 |
| Loyalty | 3 | P2 |

## 4. Success Criteria

- [ ] PluginRouteRegistration supports both legacy and openapi modes
- [ ] Manifest registration logic handles both modes
- [ ] Plugin routes appear in `GET /api/doc`
- [ ] 304 runvae integration tests pass
- [ ] 266 core tests pass
