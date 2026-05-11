# RFC-010: Production Hardening -- Operational Readiness for Real-Money Commerce

- **Status:** Complete (all 17 findings implemented)
- **Author:** Engineering
- **Date:** 2026-03-15
- **Scope:** `packages/core/src/runtime/`, `packages/core/src/interfaces/rest/`, `packages/core/src/auth/`, `packages/core/src/modules/*/schema.ts`, `packages/core/src/kernel/jobs/`
- **Depends on:** RFC-008 (OWASP hardening), RFC-009 (analytics cleanup)
- **Target workload:** 1,000 orders/day, 1M visits/month, multi-vendor marketplace
- **Estimated effort:** 10 engineering-days
- **Priority:** CRITICAL -- blocks production deployment

---

## 1. Problem Statement

The UnifiedCommerce Engine is architecturally sound: transactional inventory locking with `SELECT FOR UPDATE`, compensation chains for checkout rollback, parameterized analytics scoping, HMAC-signed webhooks, and SSRF-blocked outbound URLs. The business logic is production-grade.

The operational plumbing is not. The framework currently lacks the infrastructure-level hardening required to survive real traffic, real failures, and real attackers. Specifically:

1. **No rate limiting on any endpoint.** A single attacker can exhaust server resources, brute-force authentication, or spam checkout -- there is zero throttling at any layer.

2. **No structured logging.** The entire framework uses `console.log`. There are no structured JSON logs, no request-correlation IDs, no log-level controls, no sensitive-data redaction, and no error-tracking integration. Debugging a production incident requires SSH-ing into a container and grepping stdout.

3. **No graceful shutdown.** When the process receives `SIGTERM` (every deployment, every autoscale event), open database connections are abandoned, in-flight requests are dropped, and job-queue runners may leave jobs in a `processing` state permanently.

4. **No process crash handlers.** An unhandled promise rejection in any async code path terminates the process silently (Node.js v15+ default behavior). There is no `process.on('unhandledRejection')` handler to log the error before exit.

5. **The health check is decorative.** `GET /api/health` returns `{ status: "ok" }` unconditionally -- it never probes the database. A load balancer relying on this endpoint will continue sending traffic to an instance whose PostgreSQL connection has died.

6. **No request body size limits.** Any endpoint accepting JSON can receive an arbitrarily large payload. A `POST /api/checkout` with a 1GB body will cause the Bun/Node process to OOM.

7. **No Zod validation on REST routes.** Zod v4.1 is installed as a dependency but never applied to route handlers. Every `c.req.json()` call trusts the raw input. Malformed payloads can cause runtime exceptions that propagate as unhandled errors.

8. **Missing database indexes on high-traffic tables.** The `orders` table has zero indexes beyond the primary key and `order_number` unique constraint. Customer order lookups (`WHERE customer_id = ?`), status filtering (`WHERE status = ?`), and time-range analytics (`WHERE placed_at BETWEEN ...`) all perform sequential scans. At 365K orders/year (1K/day), these queries degrade to multi-second response times.

9. **The dev-staff-key backdoor relies on NODE_ENV.** The hardcoded `dev-staff-key` API key grants full admin access (`["*:*"]`) unless `NODE_ENV === "production"`. This is a single environment variable away from a complete authorization bypass. Environment variables are not a security boundary.

10. **Webhook delivery has no fetch timeout.** The `WebhookDeliveryWorker.deliver()` method calls `fetch()` without an `AbortSignal.timeout()`. A slow or hanging endpoint blocks the job runner indefinitely, stalling all subsequent webhook deliveries in the queue.

---

## 2. Audit of Current State

### What already works (no changes needed)

| Area | Implementation | Status |
|------|----------------|--------|
| Inventory concurrency | `SELECT FOR UPDATE SKIP LOCKED` in `reserveInventory()` | Correct |
| Checkout compensation | Reserve -> capture -> fulfill chain with rollback on failure | Correct |
| SSRF prevention | `validateWebhookUrl()` blocks RFC 1918, loopback, link-local | Correct |
| Webhook signing | HMAC-SHA256 via `signWebhookPayload()` | Correct |
| CORS | Deny-all in production unless `trustedOrigins` is explicitly set | Correct |
| Analytics scoping | Parameterized WHERE injection, deny-by-default for non-admin | Correct |
| Pagination | `MAX_PAGE_LIMIT = 100` enforced in `parsePagination()` | Correct |
| Error sanitization | `INTERNAL_ERROR` responses stripped of raw messages | Correct |
| Job queue | `FOR UPDATE SKIP LOCKED` claim, exponential backoff retry | Correct |
| Permission guards | `requirePerm()` middleware on admin routes | Correct |

### What is missing (this RFC addresses)

| # | Area | Current State | Target State |
|---|------|---------------|--------------|
| F1 | Rate limiting | None | Tiered: 10/s auth, 50/s API, 5/s checkout |
| F2 | Structured logging | `console.log` | Pino JSON logger with request IDs, redaction |
| F3 | Graceful shutdown | None | SIGTERM handler: drain HTTP, flush jobs, close DB |
| F4 | Process crash handlers | None | `unhandledRejection` + `uncaughtException` logged and exit(1) |
| F5 | Health check | Returns `{ ok }` always | Probes DB with `SELECT 1`, returns 503 on failure |
| F6 | Body size limits | None | `bodyLimit({ maxSize: 1MB })` on all routes |
| F7 | Zod route validation | Zod installed, not used | Zod schemas on checkout, orders, cart, catalog mutations |
| F8 | Database indexes | Orders: 0 indexes. Cart: 0 indexes. | 8 indexes on high-traffic columns |
| F9 | Dev backdoor removal | Gated by `NODE_ENV` | Removed entirely; use Better Auth API keys |
| F10 | Webhook fetch timeout | No timeout | `AbortSignal.timeout(10_000)` on all outbound fetches |
| F11 | Job queue dead letter | Failed jobs sit in `commerce_jobs` with status=failed | Separate query/view for failed jobs, admin alert hook |
| F12 | Request ID propagation | None | `X-Request-Id` header generated per request, passed to logger |

---

## 3. Implementation

### F1: Rate Limiting

**Dependency:** `hono-rate-limiter` (or custom middleware using in-memory Map / Redis-backed store).

**Rationale:** Hono does not ship a built-in rate limiter. The `hono-rate-limiter` package (Source Reputation: High, Benchmark: 91.7) wraps the standard `rate-limiter-flexible` library and provides a Hono-native middleware.

For a single-instance deployment (the likely initial production topology), an in-memory store suffices. For horizontally-scaled deployments, swap to a Redis store.

**Pseudocode:**

```
FUNCTION createRateLimiter(windowMs, maxRequests, keyExtractor):
    store = new Map<string, { count: number, resetAt: number }>()

    RETURN middleware(context, next):
        key = keyExtractor(context)  // IP address or API key
        now = Date.now()
        entry = store.get(key)

        IF entry IS NULL OR entry.resetAt <= now:
            store.set(key, { count: 1, resetAt: now + windowMs })
            RETURN next()

        IF entry.count >= maxRequests:
            RETURN context.json({ error: "RATE_LIMITED" }, 429)

        entry.count += 1
        RETURN next()
```

**Blueprint:**

Three tiers applied in `server.ts` before the auth middleware:

```typescript
// packages/core/src/runtime/server.ts
import { rateLimiter } from "hono-rate-limiter";

// Tier 1: Auth endpoints (brute-force protection)
app.use("/api/auth/*", rateLimiter({
  windowMs: 60 * 1000,       // 1 minute window
  limit: 10,                  // 10 requests per minute per IP
  keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown",
}));

// Tier 2: Checkout (abuse protection)
app.use("/api/checkout", rateLimiter({
  windowMs: 60 * 1000,
  limit: 5,                   // 5 checkouts per minute per IP
  keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown",
}));

// Tier 3: General API (DDoS protection)
app.use("/api/*", rateLimiter({
  windowMs: 60 * 1000,
  limit: 100,                 // 100 requests per minute per IP
  keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown",
}));
```

The `keyGenerator` uses `x-forwarded-for` because production deployments sit behind a reverse proxy (Nginx, Cloudflare, ALB). The framework should document that operators must configure their proxy to set this header truthfully; without it, all requests share a single rate limit bucket.

---

### F2: Structured Logging with Pino

**Dependency:** `pino` (v9+). Zero-dependency JSON logger. 30x faster than Winston. Used by Fastify, NestJS, and the Node.js ecosystem at scale.

**Rationale:** `console.log` provides no structure, no levels, no redaction, no correlation. Pino outputs newline-delimited JSON that integrates directly with CloudWatch, DataDog, Grafana Loki, and ELK without transformation.

**Pseudocode:**

```
FUNCTION createLogger(config):
    level = IF config.logLevel THEN config.logLevel ELSE "info"
    redactPaths = ["req.headers.authorization", "req.headers.cookie",
                   "*.password", "*.secret", "*.apiKey", "*.token"]

    logger = pino({
        level,
        redact: redactPaths,
        serializers: { req: pinoStdSerializers.req, err: pinoStdSerializers.err },
        formatters: { level: (label) => ({ level: label }) },
    })

    RETURN logger

FUNCTION requestLoggerMiddleware(logger):
    RETURN middleware(context, next):
        requestId = context.req.header("x-request-id") OR generateUUID()
        context.set("requestId", requestId)
        child = logger.child({ requestId, method: context.req.method, path: context.req.path })
        context.set("logger", child)

        startTime = performance.now()
        AWAIT next()
        duration = performance.now() - startTime

        child.info({ status: context.res.status, durationMs: round(duration) }, "request completed")
```

**Blueprint:**

New file: `packages/core/src/runtime/logger.ts`

```typescript
import pino from "pino";
import type { CommerceConfig } from "../config/types";

export type Logger = pino.Logger;

export function createLogger(config: CommerceConfig): Logger {
  return pino({
    level: config.logLevel ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.secret",
        "*.apiKey",
        "*.creditCard",
        "*.token",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      req: pino.stdSerializers.req,
      err: pino.stdSerializers.err,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
```

New middleware in `server.ts`:

```typescript
import { createLogger } from "./logger";

const logger = createLogger(config);

app.use("*", async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.header("x-request-id", requestId);
  const child = logger.child({ requestId, method: c.req.method, path: c.req.path });
  c.set("logger", child);

  const start = performance.now();
  await next();
  const duration = Math.round(performance.now() - start);

  child.info({ status: c.res.status, durationMs: duration }, "request completed");
});
```

The `logger` instance is also passed to the kernel at construction time, replacing the existing `PluginLogger` interface with Pino's native child-logger pattern.

**Config addition to `CommerceConfig`:**

```typescript
export interface CommerceConfig {
  // ... existing fields
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}
```

---

### F3: Graceful Shutdown

**Pseudocode:**

```
FUNCTION setupGracefulShutdown(server, kernel, logger):
    isShuttingDown = false

    FUNCTION shutdown(signal):
        IF isShuttingDown THEN RETURN
        isShuttingDown = true
        logger.info({ signal }, "shutdown signal received, draining...")

        // Phase 1: Stop accepting new connections
        server.close()

        // Phase 2: Wait for in-flight requests (up to 30s)
        AWAIT waitForPendingRequests(timeout: 30_000)

        // Phase 3: Close database connection pool
        AWAIT kernel.database.db.$pool.end()

        // Phase 4: Log and exit
        logger.info("shutdown complete")
        process.exit(0)

    process.on("SIGTERM", () => shutdown("SIGTERM"))
    process.on("SIGINT", () => shutdown("SIGINT"))
```

**Blueprint:**

New file: `packages/core/src/runtime/shutdown.ts`

```typescript
import type { Server } from "node:http";
import type { Logger } from "./logger";

export function setupGracefulShutdown(opts: {
  server: Server;
  cleanup: () => Promise<void>;
  logger: Logger;
  timeoutMs?: number;
}): void {
  const { server, cleanup, logger, timeoutMs = 30_000 } = opts;
  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, "shutdown signal received, draining connections");

    // Force exit after timeout to prevent hanging
    const forceTimer = setTimeout(() => {
      logger.error("shutdown timeout exceeded, forcing exit");
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    try {
      // Stop accepting new connections
      server.close();

      // Run application-specific cleanup (close DB pool, flush logs)
      await cleanup();

      logger.info("graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
```

The `cleanup` callback is wired in `createServer()` to close the database pool:

```typescript
const cleanup = async () => {
  // Close the Drizzle connection pool
  const pool = (kernel.database.db as any).$pool;
  if (pool && typeof pool.end === "function") {
    await pool.end();
  }
  // Flush Pino logs
  logger.flush();
};
```

---

### F4: Process Crash Handlers

**Blueprint:**

Added at the top of `createServer()`, before any other setup:

```typescript
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection -- exiting");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception -- exiting");
  process.exit(1);
});
```

These handlers ensure that:
1. The error is logged as structured JSON (visible in log aggregation)
2. The process exits with code 1 (so the orchestrator restarts it)
3. No silent failures -- every crash leaves a trace

---

### F5: Health Check with Database Probe

**Pseudocode:**

```
ENDPOINT GET /api/health:
    TRY:
        result = AWAIT db.execute(sql`SELECT 1 AS ok`)
        IF result[0].ok === 1:
            RETURN { status: "healthy", version, uptime: process.uptime() }, 200
    CATCH error:
        RETURN { status: "unhealthy", error: "database unreachable" }, 503
```

**Blueprint:**

Replace the current `/api/health` handler in `packages/core/src/interfaces/rest/index.ts`:

```typescript
import { sql } from "drizzle-orm";

router.get("/health", async (c) => {
  try {
    const db = kernel.database.db;
    await db.execute(sql`SELECT 1`);
    return c.json({
      status: "healthy",
      version: kernel.config.version ?? "0.0.1",
      uptime: Math.round(process.uptime()),
    });
  } catch {
    return c.json({
      status: "unhealthy",
      error: "database unreachable",
    }, 503);
  }
});
```

Load balancers (ALB, Nginx, Kubernetes liveness probe) should target this endpoint. A 503 response triggers instance replacement or traffic rerouting.

---

### F6: Body Size Limits

**Blueprint:**

Hono provides a built-in `bodyLimit` middleware. Apply globally in `server.ts`:

```typescript
import { bodyLimit } from "hono/body-limit";

// Apply before route handlers, after CORS
app.use("*", bodyLimit({
  maxSize: 1024 * 1024,  // 1 MB
  onError: (c) => c.json({
    error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1MB limit." },
  }, 413),
}));
```

For file-upload routes (media module), a higher limit can be applied per-route:

```typescript
router.post("/upload", bodyLimit({ maxSize: 50 * 1024 * 1024 }), handler);
```

---

### F7: Zod Route Validation + OpenAPI Spec Generation

**Dependency:** `@hono/zod-openapi` -- an extended Hono class that validates requests with Zod AND auto-generates an OpenAPI 3.0 specification from the same schemas. This replaces `@hono/zod-validator` (which `zod-openapi` includes internally). One dependency gives us both input validation and a machine-readable API contract.

**Rationale:** Writing Zod schemas for validation and then separately maintaining an OpenAPI spec is redundant and guaranteed to drift. `@hono/zod-openapi` makes the Zod schema the single source of truth: the validation logic IS the documentation. The generated spec enables:

- Auto-generated Swagger UI at `/api/doc` (via `@hono/swagger-ui`)
- Client SDK generation for TypeScript, Python, Go, etc. (via `openapi-generator`)
- AI agent grounding -- agents can read the OpenAPI spec to discover available endpoints, parameter types, and response shapes without custom prompting
- Contract testing -- CI can diff the generated spec against a committed baseline to catch breaking changes

**Pseudocode:**

```
IMPORT { OpenAPIHono, createRoute, z } FROM "@hono/zod-openapi"

// 1. Schemas carry both validation rules AND OpenAPI metadata
DEFINE CheckoutParamsSchema = z.object({
    cartId:            z.string().uuid().openapi({ example: "550e8400-..." }),
    shippingAddressId: z.string().uuid().optional().openapi({ example: "..." }),
    paymentMethodId:   z.string().optional(),
})

DEFINE OrderResponseSchema = z.object({
    id:         z.string().uuid(),
    status:     z.string(),
    grandTotal: z.number(),
}).openapi("Order")

// 2. Routes are declared with request + response schemas
DEFINE checkoutRoute = createRoute({
    method: "post",
    path: "/api/checkout",
    tags: ["Checkout"],
    request: { body: { content: { "application/json": { schema: CheckoutParamsSchema } } } },
    responses: {
        200: { content: { "application/json": { schema: OrderResponseSchema } }, description: "Order created" },
        422: { content: { "application/json": { schema: ErrorSchema } }, description: "Validation error" },
    },
})

// 3. Handler receives validated, typed input
app.openapi(checkoutRoute, (context) => {
    body = context.req.valid("json")  // fully typed from CheckoutParamsSchema
    // ... checkout logic
})

// 4. OpenAPI spec served at /api/doc
app.doc("/api/doc", { openapi: "3.0.0", info: { title: "UnifiedCommerce API", version: "1.0.0" } })
```

**Blueprint:**

**Architectural change:** Replace `new Hono()` with `new OpenAPIHono()` in `createRestRoutes()`. This is a drop-in replacement -- `OpenAPIHono` extends `Hono` and supports all existing `.get()`, `.post()` methods. Existing routes continue to work unchanged. New routes can incrementally adopt `app.openapi(route, handler)` for validation + documentation.

New file: `packages/core/src/interfaces/rest/schemas.ts`

```typescript
import { z } from "@hono/zod-openapi";

// ---- Shared schemas ----

export const ErrorSchema = z.object({
  error: z.object({
    code: z.string().openapi({ example: "VALIDATION_ERROR" }),
    message: z.string().openapi({ example: "cartId: Invalid uuid" }),
  }),
}).openapi("Error");

export const PaginationQuerySchema = z.object({
  page: z.string().optional().openapi({ example: "1" }),
  limit: z.string().optional().openapi({ example: "20" }),
});

// ---- Checkout ----

export const CheckoutBodySchema = z.object({
  cartId: z.string().uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  shippingAddressId: z.string().uuid().optional(),
  billingAddressId: z.string().uuid().optional(),
  paymentMethodId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
}).openapi("CheckoutRequest");

// ---- Orders ----

export const OrderSchema = z.object({
  id: z.string().uuid(),
  orderNumber: z.string(),
  status: z.string(),
  currency: z.string(),
  grandTotal: z.number(),
  placedAt: z.string(),
}).openapi("Order");

export const CreateOrderBodySchema = z.object({
  customerId: z.string().uuid().optional(),
  currency: z.string().length(3),
  items: z.array(z.object({
    entityId: z.string().uuid(),
    variantId: z.string().uuid().optional(),
    quantity: z.number().int().positive(),
  })).min(1),
}).openapi("CreateOrderRequest");

// ---- Cart ----

export const UpdateCartItemBodySchema = z.object({
  quantity: z.number().int().min(0),
}).openapi("UpdateCartItemRequest");

// ---- Catalog ----

export const CreateCatalogEntityBodySchema = z.object({
  type: z.enum(["product", "service", "digital", "bundle"]),
  slug: z.string().min(1).max(255).regex(/^[a-z0-9-]+$/),
  status: z.enum(["draft", "active", "archived"]).optional(),
  basePrice: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
}).openapi("CreateCatalogEntityRequest");

// ---- Webhooks ----

export const WebhookEndpointBodySchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
  secret: z.string().min(16).optional(),
}).openapi("WebhookEndpointRequest");
```

New file: `packages/core/src/interfaces/rest/openapi-routes.ts`

Route definitions using `createRoute()`. Each route declaration is a standalone object that carries its path, method, request schema, response schemas, and OpenAPI tags. These are registered on the `OpenAPIHono` app via `app.openapi(route, handler)`.

```typescript
import { createRoute } from "@hono/zod-openapi";
import { CheckoutBodySchema, OrderSchema, ErrorSchema } from "./schemas";

export const checkoutRoute = createRoute({
  method: "post",
  path: "/api/checkout",
  tags: ["Checkout"],
  request: {
    body: { content: { "application/json": { schema: CheckoutBodySchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderSchema } },
      description: "Checkout succeeded, order created.",
    },
    422: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Validation error.",
    },
    400: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Business logic error (empty cart, insufficient inventory, etc.).",
    },
  },
});
```

Handler registration in route files:

```typescript
import { OpenAPIHono } from "@hono/zod-openapi";
import { checkoutRoute } from "../openapi-routes";

const router = new OpenAPIHono();

router.openapi(checkoutRoute, async (c) => {
  const body = c.req.valid("json"); // typed as { cartId: string, ... }
  // ... existing checkout logic, unchanged
});
```

OpenAPI spec + Swagger UI served in `createRestRoutes()`:

```typescript
import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";

export function createRestRoutes(kernel: Kernel) {
  const router = new OpenAPIHono();

  // ... route registrations ...

  // Serve OpenAPI 3.0 JSON spec
  router.doc("/doc", {
    openapi: "3.0.0",
    info: {
      title: "UnifiedCommerce API",
      version: kernel.config.version ?? "0.0.1",
      description: "Headless commerce engine REST API.",
    },
  });

  // Serve Swagger UI at /api/reference
  router.get("/reference", swaggerUI({ url: "/api/doc" }));

  return router;
}
```

**Migration strategy:** Incremental adoption. Existing `router.get()` / `router.post()` handlers continue to work on `OpenAPIHono` without changes. As each route gets a Zod schema, it migrates from `router.post(path, handler)` to `router.openapi(routeDef, handler)`. Routes that have not yet migrated still function -- they simply do not appear in the generated OpenAPI spec.

**Scope of validation:** Apply to all mutation endpoints (POST, PATCH, PUT, DELETE) first. Read endpoints (GET) validate query parameters via `createRoute({ request: { query: schema } })`. Target: 100% coverage of public API surface within this RFC.

---

### F8: Database Indexes

The `orders`, `order_line_items`, `carts`, `cart_line_items`, and `commerce_jobs` tables have zero indexes beyond primary keys and the `order_number` unique constraint.

At 1,000 orders/day = 365,000 rows/year. Within 3 years, the orders table reaches 1M+ rows. Without indexes, every `WHERE status = ?`, `WHERE customer_id = ?`, or `WHERE placed_at BETWEEN ? AND ?` degrades from sub-millisecond to 500ms+ sequential scans.

**Blueprint:**

`packages/core/src/modules/orders/schema.ts`:

```typescript
import { index } from "drizzle-orm/pg-core";

export const orders = pgTable("orders", {
  // ... existing columns
}, (table) => [
  index("idx_orders_status").on(table.status),
  index("idx_orders_customer_id").on(table.customerId),
  index("idx_orders_placed_at").on(table.placedAt),
  index("idx_orders_payment_intent").on(table.paymentIntentId),
]);

export const orderLineItems = pgTable("order_line_items", {
  // ... existing columns
}, (table) => [
  index("idx_order_line_items_order_id").on(table.orderId),
  index("idx_order_line_items_entity_id").on(table.entityId),
]);

export const orderStatusHistory = pgTable("order_status_history", {
  // ... existing columns
}, (table) => [
  index("idx_order_status_history_order_id").on(table.orderId),
]);
```

`packages/core/src/modules/cart/schema.ts`:

```typescript
export const carts = pgTable("carts", {
  // ... existing columns
}, (table) => [
  index("idx_carts_customer_id").on(table.customerId),
  index("idx_carts_status").on(table.status),
  index("idx_carts_expires_at").on(table.expiresAt),
]);

export const cartLineItems = pgTable("cart_line_items", {
  // ... existing columns
}, (table) => [
  index("idx_cart_line_items_cart_id").on(table.cartId),
]);
```

`packages/core/src/kernel/jobs/schema.ts`:

```typescript
export const commerceJobs = pgTable("commerce_jobs", {
  // ... existing columns
}, (table) => [
  index("idx_jobs_status_queue").on(table.status, table.queue),
  index("idx_jobs_task_slug").on(table.taskSlug),
  index("idx_jobs_wait_until").on(table.waitUntil),
]);
```

`packages/core/src/modules/customers/schema.ts`:

```typescript
export const customerAddresses = pgTable("customer_addresses", {
  // ... existing columns
}, (table) => [
  index("idx_customer_addresses_customer_id").on(table.customerId),
]);

export const customerGroupMembers = pgTable("customer_group_members", {
  // ... existing columns
}, (table) => [
  index("idx_group_members_customer_id").on(table.customerId),
  index("idx_group_members_group_id").on(table.groupId),
]);
```

After adding these index definitions, run `bunx drizzle-kit push` to apply them to the database. Drizzle-kit generates `CREATE INDEX CONCURRENTLY` statements that do not lock the table during creation.

---

### F9: Dev Backdoor Removal

**Current state** (lines 90-104 of `auth/middleware.ts`):

```typescript
if (!c.get("actor") && apiKeyHeader === "dev-staff-key") {
  if (process.env.NODE_ENV === "production") {
    return c.json({ error: ... }, 401);
  }
  c.set("actor", { role: "owner", permissions: ["*:*"], ... });
}
```

**Problem:** `NODE_ENV` is not a security boundary. It is an environment variable that can be misconfigured, omitted, or set to any arbitrary value. If `NODE_ENV` is `staging`, `development`, or simply unset, the backdoor is active.

**Blueprint:**

Delete the entire `dev-staff-key` block (lines 87-104). Replace with a configuration-driven dev mode:

```typescript
// In CommerceConfig:
export interface AuthConfig {
  // ... existing fields
  /** Enable dev-mode API key. ONLY for local development. Default: false. */
  enableDevKey?: boolean;
  /** Custom dev key value. Default: random UUID generated at startup. */
  devKey?: string;
}
```

In `authMiddleware`:

```typescript
if (!c.get("actor") && config.auth?.enableDevKey && apiKeyHeader === config.auth.devKey) {
  c.set("actor", {
    type: "user",
    userId: "dev-staff",
    email: "dev@local",
    name: "Dev Admin",
    vendorId: null,
    organizationId: null,
    role: "owner",
    permissions: ["*:*"],
  } satisfies Actor);
}
```

The key differences:
1. The backdoor is OFF by default. No `enableDevKey: true` in config = no backdoor.
2. The key is configurable per deployment, not hardcoded as `"dev-staff-key"`.
3. There is no `NODE_ENV` check. The config property is the sole gate.
4. A deployer must explicitly opt in. Accidental exposure requires two mistakes (enabling the flag AND exposing the key), not one (misconfiguring NODE_ENV).

---

### F10: Webhook Fetch Timeout

**Current state** (line 63 of `webhooks/worker.ts`):

```typescript
const response = await this.fetchImpl(args.endpoint.url, { ... });
```

No timeout. A slow or hanging endpoint blocks the job runner thread indefinitely.

**Blueprint:**

```typescript
const response = await this.fetchImpl(args.endpoint.url, {
  method: "POST",
  headers: { ... },
  body: JSON.stringify(args.payload),
  signal: AbortSignal.timeout(10_000),  // 10 second timeout
});
```

`AbortSignal.timeout()` is supported in Node.js 18+, Bun, Deno, and Cloudflare Workers. It throws an `AbortError` after the specified duration, which the existing `try/catch` block already handles as a failed delivery attempt.

---

### F11: Job Queue Dead Letter Visibility

**Current state:** Failed jobs (after `maxAttempts` exhausted) remain in `commerce_jobs` with `status = 'failed'`. There is no alerting, no admin route, and no cleanup.

**Blueprint:**

This does not require a separate table. The existing schema already has `status`, `error`, `completedAt`, and `attempts` columns. Add:

1. An admin route to query failed jobs:

```typescript
// GET /api/admin/jobs/failed?limit=50
router.get("/admin/jobs/failed", requirePerm("jobs:admin"), async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const failed = await db.select()
    .from(commerceJobs)
    .where(eq(commerceJobs.status, "failed"))
    .orderBy(desc(commerceJobs.completedAt))
    .limit(limit);
  return c.json({ data: failed });
});
```

2. A retry endpoint:

```typescript
// POST /api/admin/jobs/:id/retry
router.post("/admin/jobs/:id/retry", requirePerm("jobs:admin"), async (c) => {
  const id = c.req.param("id");
  await db.update(commerceJobs)
    .set({ status: "pending", attempts: 0, error: null, waitUntil: null })
    .where(eq(commerceJobs.id, id));
  return c.json({ data: { retried: true } });
});
```

3. A `job.failed` webhook event emitted when a job exhausts all retries, allowing operators to wire alerts via their existing webhook infrastructure.

---

### F12: Request ID Propagation

**Blueprint:**

The request ID is generated in the logging middleware (F2) and set on the response via `c.header("x-request-id", requestId)`. To propagate it to the database layer (for correlating slow queries with requests), pass it through the kernel's logger:

```typescript
// In the request middleware:
const child = logger.child({ requestId });
c.set("logger", child);
c.set("requestId", requestId);

// In route handlers, pass to service calls:
const result = await kernel.services.orders.create({ ...body, requestId });

// In service layer, include in audit logs:
await kernel.services.audit.record({
  event: "order.created",
  entityId: order.id,
  metadata: { requestId },
});
```

---

## 4. New Dependencies

| Package | Version | Purpose | Size |
|---------|---------|---------|------|
| `pino` | ^9.0.0 | Structured JSON logging | 148 KB |
| `hono-rate-limiter` | ^0.4.0 | Rate limiting middleware for Hono | 12 KB |
| `@hono/zod-openapi` | ^0.18.0 | Zod validation + OpenAPI 3.0 spec generation (includes `@hono/zod-validator` internally) | 28 KB |
| `@hono/swagger-ui` | ^0.5.0 | Serves Swagger UI at `/api/reference` from the generated spec | 8 KB |

Total: ~196 KB. No native bindings. All four are pure JavaScript/TypeScript.

Note: `@hono/zod-openapi` re-exports `z` from Zod with an additional `.openapi()` method. The existing `zod` dependency (already in core's `package.json`) is a peer dependency -- no version conflict. Schemas defined with `@hono/zod-openapi`'s `z` are fully compatible with plain Zod; the `.openapi()` calls are additive metadata, not runtime changes.

### What the OpenAPI spec enables

1. **`GET /api/doc`** -- JSON OpenAPI 3.0 specification, machine-readable. Consumed by Swagger UI, Redoc, Postman, or any OpenAPI-compatible tool.
2. **`GET /api/reference`** -- Interactive Swagger UI. Developers can explore endpoints, see request/response schemas, and execute test requests from the browser.
3. **Client SDK generation** -- Run `npx openapi-generator-cli generate -i http://localhost:3000/api/doc -g typescript-fetch -o ./sdk/` to produce a fully typed TypeScript client.
4. **AI agent discovery** -- Agents fetch `/api/doc` to understand the available endpoints, parameter shapes, and response types without hardcoded prompting. This complements the existing `analytics_meta` MCP tool for analytics-specific discovery.

---

## 5. Plugin Route DX: OpenAPI as the Enforced Contract

### Problem with the current plugin route interface

The `PluginRouteRegistration` interface currently accepts a raw handler function with no schema:

```typescript
// Current: packages/core/src/kernel/plugin/manifest.ts
export interface PluginRouteRegistration {
  method: string;
  path: string;
  handler: (...args: unknown[]) => unknown;  // untyped, no validation, no docs
}
```

The kernel wires it with a raw Hono call:

```typescript
// Line 124 in manifest.ts
router[method]!(route.path, route.handler);
```

This means plugin routes:
- Have `c: any` context with no type inference on request bodies
- Perform ad-hoc validation (manual `if (!body.name)` checks)
- Do not appear in the OpenAPI specification
- Cannot be discovered by SDK generators or AI agents
- Have inconsistent error response shapes across plugins

### Proposed: OpenAPI-only route registration

Replace `PluginRouteRegistration` entirely. Every plugin route must provide a `createRoute()` definition with Zod schemas. No raw handlers, no unvalidated endpoints.

**Pseudocode:**

```
TYPE PluginRouteRegistration = {
    openapi: RouteConfig,     // createRoute() definition with schemas
    handler: Function,        // handler receives validated, typed context
}

FUNCTION registerPluginRoutes(app: OpenAPIHono, routes: PluginRouteRegistration[]):
    FOR EACH route IN routes:
        app.openapi(route.openapi, route.handler)
```

**Blueprint:**

Updated type in `packages/core/src/kernel/plugin/manifest.ts`:

```typescript
import type { RouteConfig } from "@hono/zod-openapi";

/**
 * Plugin route registration. Every route MUST provide an OpenAPI route
 * definition with Zod request/response schemas. This enforces:
 * - Input validation on every endpoint
 * - Auto-generated OpenAPI documentation
 * - Type-safe handler context
 */
export interface PluginRouteRegistration {
  openapi: RouteConfig;
  handler: (...args: unknown[]) => unknown;
}
```

Updated registration logic in `defineCommercePlugin`:

```typescript
for (const route of regs) {
  (app as OpenAPIHono).openapi(route.openapi, route.handler as any);
}
```

### Plugin developer experience: before vs after

**Before (current):**

```typescript
// plugin-marketplace/src/routes/vendors.ts
{
  method: "POST",
  path: "/api/marketplace/vendors",
  async handler(c: any) {                           // <-- untyped
    const body = await c.req.json();                // <-- unvalidated
    if (!body.name) {                               // <-- manual check
      return c.json({ error: "name is required" }, 422);
    }
    const vendor = await services.vendor.create(body);
    return c.json({ data: vendor }, 201);
  },
},
```

**After (OpenAPI route):**

```typescript
// plugin-marketplace/src/routes/vendors.ts
import { createRoute, z } from "@hono/zod-openapi";

const CreateVendorSchema = z.object({
  name: z.string().min(1).openapi({ example: "Acme Co" }),
  commissionRateBps: z.number().int().min(0).max(10000).optional()
    .openapi({ example: 1000, description: "Basis points (100 = 1%)" }),
  contactEmail: z.string().email().optional(),
}).openapi("CreateVendorRequest");

const VendorSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: z.string(),
  tier: z.string(),
  commissionRateBps: z.number(),
  createdAt: z.string(),
}).openapi("Vendor");

const createVendorRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors",
  tags: ["Marketplace"],                            // <-- grouped in Swagger UI
  request: {
    body: {
      content: {
        "application/json": { schema: CreateVendorSchema },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: VendorSchema } },
      description: "Vendor created successfully.",
    },
    422: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Validation error.",
    },
    403: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Missing marketplace:admin permission.",
    },
  },
});

// In the route array returned by the plugin:
{
  openapi: createVendorRoute,
  handler: async (c) => {
    const denied = checkAdmin(c); if (denied) return denied;
    const body = c.req.valid("json");              // typed: { name: string, ... }
    const vendor = await services.vendor.create({
      ...body,
      commissionRateBps: body.commissionRateBps ?? defaultBps,
    });
    return c.json({ data: vendor }, 201);
  },
},
```

### What this enforces

| Aspect | Before (current) | After (OpenAPI-only) |
|--------|-------------------|----------------------|
| Input typing | `c: any`, manual casts | Fully typed from Zod schema |
| Validation | Manual `if` checks, inconsistent | Automatic Zod validation, 422 on failure |
| Error format | Plugin-specific (string, object, varies) | Uniform `{ error: { code, message } }` |
| Documentation | None -- consumers must read source code | Auto-generated in `/api/doc` + Swagger UI |
| Discoverability | Manual -- must know the endpoint exists | Agents and SDK generators find it automatically |
| Breaking changes | Silent -- nothing checks compatibility | Spec diff in CI catches breaking changes |
| Can ship without schema? | Yes (the current default) | No (TypeScript compiler rejects it) |

### Schema sharing across plugins

Plugins re-export their Zod schemas so other plugins and the storefront can import them:

```typescript
// @unifiedcommerce/plugin-marketplace exports:
export { CreateVendorSchema, VendorSchema } from "./routes/schemas";
```

A storefront developer building a vendor onboarding form can import `CreateVendorSchema` and use it for client-side validation -- the same schema that validates on the server. One source of truth from database to browser.

### AI agent grounding via OpenAPI

When an AI agent (Claude, GPT, custom LLM) fetches `GET /api/doc`, it receives the complete API contract including:
- Every endpoint path, method, and description
- Request body schemas with field types, constraints, and examples
- Response shapes for success and error cases
- Tags grouping endpoints by domain (Checkout, Catalog, Marketplace, etc.)

This eliminates prompt-engineering guesswork. The agent does not need a handcrafted system prompt listing every endpoint -- it reads the spec. Combined with the existing `analytics_meta` MCP tool for analytics discovery, the agent has a complete, machine-readable understanding of the platform's capabilities.

---

## 6. Configuration Additions

```typescript
export interface CommerceConfig {
  // ... existing fields

  /** Log level. Default: "info". Set to "debug" for development. */
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace";

  /** Rate limiting overrides. */
  rateLimits?: {
    /** Requests per minute for general API. Default: 100. */
    api?: number;
    /** Requests per minute for auth endpoints. Default: 10. */
    auth?: number;
    /** Requests per minute for checkout. Default: 5. */
    checkout?: number;
  };
}
```

Also remove the incremental migration language from section 5 and the "legacy" route support. Since there are no external developers, all plugin routes migrate to OpenAPI in one pass. The `PluginRouteRegistration` type becomes OpenAPI-only:

```typescript
export interface PluginRouteRegistration {
  openapi: RouteConfig;
  handler: (...args: unknown[]) => unknown;
}
```

No legacy fallback. Every plugin route is validated and documented from day one.

---

## 7. Type Safety: Eliminate All `as any` and Double-Casts

### Audit results

A full-codebase audit found **68 `as any` casts** and **8 `as unknown as` double-casts** across production code and tests.

**Production code (16 occurrences across 12 files) -- all must be fixed:**

| File | Line(s) | Current Pattern | Fix |
|------|---------|-----------------|-----|
| `core/src/hooks/checkout.ts` | 127, 129 | `(cart.value as any).status` | Add `status` field to Cart Result type, or extract with a type guard |
| `core/src/auth/setup.ts` | 66 | `roles as unknown as Record<...>` | Define a `BetterAuthRoleConfig` type that matches both our config and Better Auth's expected shape |
| `core/src/auth/setup.ts` | 123 | `auth as unknown as AuthInstance` | Define `AuthInstance` to properly extend Better Auth's return type using `ReturnType<typeof betterAuth>` |
| `core/src/runtime/kernel.ts` | 153 | `handlers as unknown as HookHandler[]` | Use `Array.isArray()` + type narrowing instead of double-cast |
| `core/src/runtime/server.ts` | 62 | `app as unknown as Hono` | Define `CommerceApp` type alias extending `OpenAPIHono` with proper generics |
| `core/src/kernel/plugin/manifest.ts` | 122 | `app as unknown as Record<string, ...>` | Replace with `OpenAPIHono.openapi()` registration (eliminated by F7 OpenAPI-only routes) |
| `core/src/kernel/factory/repository-factory.ts` | 162 | `query as unknown as Promise<...>` | Use Drizzle's `$inferSelect` type + `.$dynamic()` for composable queries |
| `core/src/interfaces/rest/routes/promotions.ts` | 20 | `input as unknown as CreatePromotionInput` | Parse body through Zod schema first (eliminated by F7) |
| `adapters/adapter-s3/src/index.ts` | 59 | `currentClient as any, command as any` | Widen `S3ClientLike` interface to match AWS SDK's `getSignedUrl` generics |
| `adapters/adapter-stripe/src/index.ts` | 78 | `reason as any` | Map reason string to `Stripe.RefundCreateParams.Reason` enum explicitly |
| `deployment/cloudflare/src/index.ts` | 16 | `env as any, ctx as any` | Define `CloudflareEnv` type including all Hono binding fields |
| `cli/src/commands/import.ts` | 224, 225, 262, 263, 299 | `products as any[]`, `mapping as any` | Define `ImportProduct`, `ImportCustomer`, `ImportMapping` interfaces |

**Test code (52 occurrences) -- refactor to test utilities:**

Most test `as any` casts are mock Actor objects. Create a typed test helper:

```typescript
// packages/core/src/test-utils/mock-actor.ts
import type { Actor } from "../auth/types";

export function mockActor(overrides?: Partial<Actor>): Actor {
  return {
    type: "user",
    userId: "test-user-id",
    email: "test@example.com",
    name: "Test User",
    vendorId: null,
    organizationId: null,
    role: "owner",
    permissions: ["*:*"],
    ...overrides,
  };
}

export function mockCustomerActor(customerId: string): Actor {
  return mockActor({
    userId: customerId,
    role: "customer",
    permissions: ["catalog:read", "cart:*", "orders:read:own"],
  });
}

export function mockVendorActor(vendorId: string): Actor {
  return mockActor({
    vendorId,
    role: "vendor",
    permissions: ["catalog:read", "inventory:read"],
  });
}
```

This eliminates all 52 test-file `as any` casts. Instead of `{ userId: "x", permissions: ["*:*"] } as any`, tests use `mockActor()`.

### Enforcement

Add `"noUncheckedIndexedAccess": true` and a CI-enforced lint rule to `tsconfig.json`:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

Add an ESLint rule to reject `as any`:

```jsonc
// eslint.config.js
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "error"
  }
}
```

This makes `as any` a compilation error. No new `as any` can enter the codebase after this RFC.

---

## 8. Better Auth Integration Audit

### What is correctly implemented

| Aspect | Implementation | Verdict |
|--------|----------------|---------|
| Session verification | `auth.api.getSession({ headers })` | Correct -- Better Auth handles token extraction, signature verification, and expiry |
| Password hashing | Delegated to Better Auth (bcrypt/argon2 internally) | Correct -- never handled manually |
| Email verification | `requireEmailVerification: true` by default in setup | Correct |
| Two-factor auth | `twoFactor()` plugin, conditional on config | Correct |
| API key verification | `auth.api.verifyApiKey({ key })` | Correct |
| Organization multi-tenancy | `organization()` plugin with custom roles | Correct |
| Session expiry | Configurable, defaults to 7 days (604,800s) | Correct |
| CORS | Deny-all in production, explicit `trustedOrigins` required | Correct |
| Permission resolution | Role-based from config, wildcard `*:*` support | Correct |
| Customer actor resolution | `resolveCustomerActor()` bridges auth userId to customer UUID | Correct |

### What is missing or incorrectly implemented

#### F13: Cookie Security Not Explicitly Configured

**Current state:** Better Auth v1.3.8 defaults are relied upon. No explicit cookie configuration is passed to `betterAuth()`.

Better Auth defaults are likely secure (HttpOnly, Secure in HTTPS, SameSite=Lax), but "likely" is not "verified". The defaults are internal implementation details of Better Auth that can change between minor versions without notice.

**Blueprint:**

Add explicit cookie config in `auth/setup.ts`:

```typescript
const auth = betterAuth({
  // ... existing config
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,  // 5 minute cookie cache
    },
  },
  advanced: {
    cookiePrefix: "uc",              // "uc.session_token" instead of "better-auth.session_token"
    useSecureCookies: process.env.NODE_ENV === "production",
    crossSubDomainCookies: {
      enabled: false,                // off by default, enable only if needed
    },
  },
});
```

#### F14: CSRF Protection Gap

**Current state:** CSRF protection relies on two implicit layers:
1. SameSite=Lax cookies (prevent cross-origin form submissions)
2. CORS origin whitelist (prevent cross-origin AJAX)

This is sufficient for browsers that support SameSite cookies (all modern browsers). However, older browsers (IE 11, some embedded WebViews) may not respect SameSite, leaving only CORS as protection.

**Blueprint:**

Hono has a built-in CSRF middleware. Add it for mutation endpoints:

```typescript
import { csrf } from "hono/csrf";

// Apply to mutation endpoints only (POST, PATCH, PUT, DELETE)
// GET/HEAD/OPTIONS are safe methods and don't need CSRF protection
app.use("/api/*", csrf({
  origin: trustedOrigins.length > 0
    ? trustedOrigins
    : (process.env.NODE_ENV === "production" ? [] : ["http://localhost:*"]),
}));
```

Hono's CSRF middleware validates the `Origin` header against the allowed origins list. It only applies to unsafe methods (POST, PATCH, PUT, DELETE) with form-compatible content types. This is defense-in-depth alongside SameSite cookies.

#### F15: Permission Guard Coverage Gaps

**Current state:** RFC-008 added `requirePerm()` middleware to several routes. The audit found routes that still lack permission guards:

| Route | Current Guard | Required Guard |
|-------|---------------|----------------|
| `POST /api/pricing` | None | `pricing:manage` |
| `PATCH /api/pricing/:id` | None | `pricing:manage` |
| `DELETE /api/pricing/:id` | None | `pricing:manage` |
| `POST /api/promotions` | None | `promotions:manage` |
| `PATCH /api/promotions/:id` | None | `promotions:manage` |
| `DELETE /api/promotions/:id` | None | `promotions:manage` |

The `requirePerm()` middleware is already implemented in `utils.ts`. These routes simply need it applied.

**Blueprint:**

```typescript
// routes/pricing.ts
router.post("/", requirePerm("pricing:manage"), async (c) => { ... });
router.patch("/:id", requirePerm("pricing:manage"), async (c) => { ... });
router.delete("/:id", requirePerm("pricing:manage"), async (c) => { ... });

// routes/promotions.ts
router.post("/", requirePerm("promotions:manage"), async (c) => { ... });
router.patch("/:id", requirePerm("promotions:manage"), async (c) => { ... });
router.delete("/:id", requirePerm("promotions:manage"), async (c) => { ... });
```

#### F16: AuthInstance Type Gap

**Current state** (auth/setup.ts line 123):

```typescript
return auth as unknown as AuthInstance;
```

`AuthInstance` is a manually defined interface that approximates Better Auth's return type. The double-cast `as unknown as` hides type mismatches between our interface and the actual return value.

**Blueprint:**

Replace the manual `AuthInstance` interface with a derived type:

```typescript
// auth/setup.ts
function createAuthInternal(database: DatabaseAdapter, config: CommerceConfig) {
  const auth = betterAuth({ ... });
  return auth;
}

export type AuthInstance = ReturnType<typeof createAuthInternal>;

export function createAuth(database: DatabaseAdapter, config: CommerceConfig): AuthInstance {
  return createAuthInternal(database, config);
}
```

This derives `AuthInstance` from the actual `betterAuth()` return type. No double-cast needed. TypeScript infers the exact shape including all plugin-contributed methods (`verifyApiKey`, etc.).

#### F17: API Key Permission Fallback

**Current state** (middleware.ts line 74-77):

```typescript
permissions:
  keyResult.permissions ??
  config.auth?.roles?.ai_agent?.permissions ??
  [],
```

If an API key has no stored permissions, the middleware falls back to `ai_agent` role permissions. This is a hidden coupling between API keys and a role named `ai_agent` -- if the role doesn't exist in config, the key gets zero permissions (empty array).

**Blueprint:**

Make the fallback explicit in config:

```typescript
// config/types.ts
export interface ApiKeyConfig {
  enabled?: boolean;
  /** Default permissions for API keys that don't specify their own. */
  defaultPermissions?: string[];
}
```

```typescript
// middleware.ts
permissions:
  keyResult.permissions ??
  config.auth?.apiKeys?.defaultPermissions ??
  [],
```

No hidden coupling to a magic role name.

---

## 9. Success Criteria

### Security

### Security
- [ ] `dev-staff-key` string does not appear anywhere in the codebase
- [ ] Auth endpoints rate-limited to 10 req/min per IP
- [ ] Checkout rate-limited to 5 req/min per IP
- [ ] Request body size capped at 1 MB (50 MB for file uploads)
- [ ] All POST/PATCH/PUT routes validate input with Zod schemas
- [ ] Cookie security explicitly configured (HttpOnly, Secure, SameSite, prefix)
- [ ] CSRF middleware applied to mutation endpoints
- [ ] Permission guards on all pricing and promotion mutation routes
- [ ] API key default permissions configured via `config.auth.apiKeys.defaultPermissions`, not magic role name

### Reliability
- [ ] `GET /api/health` returns 503 when database is unreachable
- [ ] SIGTERM triggers graceful drain (30s timeout, then force exit)
- [ ] `unhandledRejection` and `uncaughtException` logged before exit
- [ ] Webhook fetch timeout set to 10 seconds
- [ ] Failed jobs visible via `GET /api/admin/jobs/failed`

### Performance
- [ ] `idx_orders_status` index exists
- [ ] `idx_orders_customer_id` index exists
- [ ] `idx_orders_placed_at` index exists
- [ ] `idx_order_line_items_order_id` index exists
- [ ] `idx_cart_line_items_cart_id` index exists
- [ ] `idx_jobs_status_queue` index exists
- [ ] `SELECT * FROM orders WHERE customer_id = ? LIMIT 20` executes in < 5ms at 500K rows

### Observability
- [ ] All logs are JSON (Pino)
- [ ] Every response includes `X-Request-Id` header
- [ ] Sensitive fields (`authorization`, `password`, `token`, `secret`) are redacted in logs
- [ ] Request duration logged for every request
- [ ] `logLevel` configurable via `CommerceConfig`

### API Documentation and Plugin DX
- [ ] `GET /api/doc` returns valid OpenAPI 3.0 JSON spec
- [ ] `GET /api/reference` serves interactive Swagger UI
- [ ] All core mutation endpoints (POST/PATCH/PUT/DELETE) appear in the spec with request/response schemas
- [ ] OpenAPI spec validates without errors via `npx @redocly/cli lint /api/doc`
- [ ] `PluginRouteRegistration` type requires `{ openapi, handler }` -- no raw handler path
- [ ] All plugin routes (marketplace, POS) migrated to OpenAPI route definitions
- [ ] Plugin routes appear in `/api/doc` under their respective tags (Marketplace, POS, etc.)
- [ ] Plugin Zod schemas exported for client-side reuse

### Type Safety
- [ ] Zero `as any` in production code (enforced by `@typescript-eslint/no-explicit-any: error`)
- [ ] Zero `as unknown as` double-casts in production code
- [ ] `AuthInstance` derived from `ReturnType<typeof betterAuth>`, not manually defined
- [ ] `mockActor()` test helper replaces all 52 test-file `as any` casts
- [ ] `noUncheckedIndexedAccess: true` enabled in tsconfig
- [ ] CI fails on any `as any` introduction

### Testing
- [ ] Rate limiting returns 429 on threshold breach
- [ ] Body limit returns 413 on oversized payload
- [ ] Health check returns 503 when DB connection fails
- [ ] Zod validation returns 422 with structured error on invalid input
- [ ] Graceful shutdown test: send SIGTERM, verify DB pool closed
- [ ] CSRF middleware rejects cross-origin POST without valid Origin header
- [ ] All existing 266 core tests continue to pass
