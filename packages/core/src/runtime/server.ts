import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { rateLimiter } from "hono-rate-limiter";
import { createHash } from "node:crypto";
import { createClientIpResolver } from "./client-ip.js";
import type { Actor } from "../auth/types.js";
import type { AuthInstance } from "../auth/setup.js";
import type { CommerceConfig } from "../config/types.js";
import { authMiddleware } from "../auth/middleware.js";
import { CommerceCsrfError } from "../kernel/errors.js";
import { createRestRoutes } from "../interfaces/rest/index.js";
import { createCustomerPortalRoutes } from "../interfaces/rest/customer-portal.js";
import { createKernel } from "./kernel.js";
import { ensureDefaultOrg } from "../auth/org.js";
import { createLogger, type Logger } from "./logger.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";
import { createCommerce, type CommerceInstance } from "./commerce.js";
import { rewriteCommerceAliasRequest } from "./url-alias-rewrite.js";
import { mapErrorToResponse } from "../kernel/error-mapper.js";

type ServerEnv = {
  Variables: {
    auth: AuthInstance;
    actor: Actor | null;
    requestId: string;
    logger: Logger;
  };
};

/**
 * Returns true if running in a Node-like runtime that supports
 * `process.on()` + `process.exit()`. Edge runtimes (Cloudflare Workers,
 * Vercel Edge) return false — caller should skip process-crash handlers
 * and defer unhandled errors to the platform.
 *
 * Exposed for direct unit testing — see test/server-edge-runtime.test.ts.
 */
export function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.on === "function" &&
    typeof process.exit === "function"
  );
}

function hashRateLimitEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

function matchPathPattern(path: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return path.startsWith(pattern.slice(0, -1));
  }
  return path === pattern;
}

/**
 * Create a full HTTP server (Hono) with all REST routes, auth, and middleware.
 *
 * For server-side frameworks (Next.js, TanStack Start, SvelteKit), use
 * `createCommerce()` instead — it gives you a local API without HTTP overhead.
 */
export async function createServer(config: CommerceConfig) {
  const commerce = await createCommerce(config);
  const { kernel, auth, logger } = commerce;
  const isProdEnv = process.env.NODE_ENV === "production";

  const app = new OpenAPIHono<ServerEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({
          error: {
            code: "VALIDATION_FAILED",
            message: isProdEnv
              ? "Invalid input."
              : result.error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; "),
          },
        }, 422);
      }
    },
  });

  // ─── Security Guards ──────────────────────────────────────────────
  if ((config.auth as Record<string, unknown>)?.enableDevKey !== undefined) {
    throw new Error(
      "FATAL: auth.enableDevKey has been removed. " +
      "Use 'bunx @porulle/cli api-key create --scope admin' to generate a real API key. " +
      "See https://github.com/asyncdotengineering/porulle/blob/main/SECURITY.md for the auth/key scoping rationale.",
    );
  }
  if ((config.auth as Record<string, unknown>)?.devKey !== undefined) {
    throw new Error(
      "FATAL: auth.devKey has been removed. " +
      "Use 'bunx @porulle/cli api-key create --scope admin' to generate a real API key. " +
      "See https://github.com/asyncdotengineering/porulle/blob/main/SECURITY.md for the auth/key scoping rationale.",
    );
  }

  // exposed for direct unit testing — see test/server-edge-runtime.test.ts
  // ─── Process Crash Handlers (F4) ─────────────────────────────────────
  if (isNodeRuntime()) {
    process.on("unhandledRejection", (reason) => {
      logger.fatal({ err: reason }, "unhandled promise rejection -- exiting");
      process.exit(1);
    });

    process.on("uncaughtException", (err) => {
      logger.fatal({ err }, "uncaught exception -- exiting");
      process.exit(1);
    });
  } else {
    logger.info("running on edge runtime — process crash handlers skipped");
  }

  // ─── Security Response Headers ──────────────────────────────────────
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (isProdEnv) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    await next();
  });

  // ─── Request ID + Logging (F2, F12) ──────────────────────────────────
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.header("x-request-id", requestId);
    c.set("requestId", requestId);
    const child = logger.child({ requestId, method: c.req.method, path: c.req.path });
    c.set("logger", child);

    const start = performance.now();
    await next();

    // Sanitize ZodError responses in production.
    // @hono/zod-openapi returns { success: false, error: { name: "ZodError" } }
    // which leaks schema details. The library does not respect defaultHook for
    // this format, so we intercept at the response level.
    if (isProdEnv && c.res.status >= 400 && c.res.status < 500) {
      const ct = c.res.headers.get("content-type");
      if (ct?.includes("json")) {
        try {
          const body = await c.res.clone().json();
          if (body?.error?.name === "ZodError") {
            c.res = new Response(
              JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "Invalid input." } }),
              { status: 422, headers: { "content-type": "application/json" } },
            );
          }
        } catch { /* non-parseable, skip */ }
      }
    }

    const duration = Math.round(performance.now() - start);

    child.info({ status: c.res.status, durationMs: duration }, "request completed");
  });

  // ─── CORS (hardened by default) ──────────────────────────────────────
  const trustedOrigins = config.auth?.trustedOrigins ?? [];
  app.use("*", cors({
    origin: trustedOrigins.length > 0
      ? trustedOrigins
      : (process.env.NODE_ENV === "production" ? [] : ["http://localhost:*"]),
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-request-id"],
    maxAge: 86400,
  }));

  // ─── CSRF Protection (F14) ──────────────────────────────────────────
  // CSRF defends cookie/session auth, where the browser attaches the credential
  // ambiently. API-key (x-api-key) and bearer-token requests carry an explicit,
  // non-ambient credential and are not CSRF-attackable, so the guard is skipped
  // for them — otherwise a bodyless server-to-server POST (no Origin, no JSON
  // content-type, e.g. /publish or /archive from the SDK) trips CSRF and 403s
  // for no security benefit.
  const csrfGuard = csrf({
    origin: trustedOrigins.length > 0
      ? trustedOrigins
      : (process.env.NODE_ENV === "production" ? [] : ["http://localhost:*"]),
  });
  app.use("/api/*", async (c, next) => {
    const authenticatedByKey =
      !!c.req.header("x-api-key") ||
      /^Bearer\s+/i.test(c.req.header("authorization") ?? "");
    if (authenticatedByKey) return next();

    // Run only the CSRF origin check here; invoke the real downstream afterwards
    // so a genuine 403 from a route handler can't be misattributed to CSRF.
    let passedCsrf = false;
    try {
      await csrfGuard(c, async () => {
        passedCsrf = true;
      });
    } catch (err) {
      if (err instanceof HTTPException && err.status === 403) {
        throw new CommerceCsrfError(
          "Origin check failed: the request Origin is not in the trusted origins allowlist. " +
            "Browser clients must send a trusted Origin; server-to-server callers should authenticate with an API key (x-api-key).",
        );
      }
      throw err;
    }
    if (!passedCsrf) return;
    return next();
  });

  // ─── Body Size Limit (F6) ──────────────────────────────────────────
  // Media uploads (phone photos are 3–8MB) get their own larger limit and are
  // exempt from the global 1MB limit. Everything else stays at 1MB.
  const mediaMaxUploadSize = config.media?.maxUploadSize ?? 10 * 1024 * 1024;
  const MEDIA_UPLOAD_PATH = "/api/media/upload";

  app.use(MEDIA_UPLOAD_PATH, bodyLimit({
    maxSize: mediaMaxUploadSize,
    onError: (c) => c.json({
      error: { code: "FILE_TOO_LARGE", message: `Upload exceeds the ${mediaMaxUploadSize}-byte limit.` },
    }, 413),
  }));

  const globalBodyLimit = bodyLimit({
    maxSize: 1024 * 1024,  // 1 MB default
    onError: (c) => c.json({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1MB limit." },
    }, 413),
  });
  app.use("*", (c, next) =>
    c.req.path === MEDIA_UPLOAD_PATH ? next() : globalBodyLimit(c, next),
  );

  // ─── Rate Limiting (F1) ──────────────────────────────────────────────
  // Client IP drives the rate-limit key. Defaults to the Node socket address
  // (trusting X-Forwarded-For only from a known proxy via config.runtime
  // .trustedProxyIp / TRUSTED_PROXY_IP); edge runtimes inject
  // config.runtime.getClientIp to read the platform header instead.
  const signInEmailRateKeyCache = new WeakMap<Request, string>();
  const getClientIp = createClientIpResolver(config);
  const keyGenerator = getClientIp;

  app.use("/api/auth/*", rateLimiter({
    windowMs: 60 * 1000,
    limit: config.rateLimits?.auth ?? 10,
    keyGenerator,
  }));

  app.use("/api/auth/sign-in/email", async (c, next) => {
    if (c.req.method !== "POST") {
      await next();
      return;
    }
    try {
      const payload = await c.req.raw.clone().json() as { email?: unknown };
      if (typeof payload.email === "string" && payload.email.trim().length > 0) {
        signInEmailRateKeyCache.set(c.req.raw, hashRateLimitEmail(payload.email));
      }
    } catch {
      // Ignore parse failures; endpoint validation will handle malformed bodies.
    }
    await next();
  });

  app.use("/api/auth/sign-in/email", rateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: config.rateLimits?.signInPerEmail ?? 10,
    keyGenerator: (c) =>
      signInEmailRateKeyCache.get(c.req.raw) ?? "signin-email:unknown",
  }));

  app.use("/api/checkout", rateLimiter({
    windowMs: 60 * 1000,
    limit: config.rateLimits?.checkout ?? 5,
    keyGenerator,
  }));

  app.use("/api/*", rateLimiter({
    windowMs: 60 * 1000,
    limit: config.rateLimits?.api ?? 100,
    keyGenerator,
  }));

  app.use("*", async (c, next) => {
    await next();
    const csp = config.security?.csp;
    if (!csp) return;
    // Recommended checkout policy baseline (adjust provider domains):
    // default-src 'self'; script-src 'self' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
    const routePolicy = Object.entries(csp.perRoute ?? {}).find(([pattern]) =>
      matchPathPattern(c.req.path, pattern),
    )?.[1];
    const policy = routePolicy ?? csp.default;
    if (policy) {
      c.header("Content-Security-Policy", policy);
    }
  });

  // ─── Custom Middleware ──────────────────────────────────────────────
  if (config.middleware) {
    for (const middleware of config.middleware) {
      app.use("*", middleware);
    }
  }

  // ─── Auth ──────────────────────────────────────────────────────────
  app.use("/api/auth/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/pos/")) {
      await next();
      return;
    }
    return auth.handler(c.req.raw);
  });

  app.use("*", authMiddleware(auth, config));
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });

  // ─── Global Error Handler ─────────────────────────────────────────
  const isProd = process.env.NODE_ENV === "production";
  app.onError((err, c) => {
    const { body, status } = mapErrorToResponse(err, isProd, logger);
    return c.json(body, status);
  });

  // ─── Routes ──────────────────────────────────────────────────────────
  app.route("/api", createRestRoutes(kernel));
  // Mounted under /api so the auth middleware, rate limiter, CSRF, and
  // body-limit stack apply (all are scoped to /api/*).
  app.route("/api/me", createCustomerPortalRoutes(kernel));

  if (config.routes) {
    config.routes(app, kernel);
  }

  // OpenAPI spec — disabled in production unless explicitly enabled
  const exposeSpec = config.exposeOpenApiSpec ?? !isProd;
  if (exposeSpec) {
    app.doc("/api/doc", {
      openapi: "3.0.0",
      info: {
        title: "UnifiedCommerce API",
        version: config.version ?? "0.0.1",
        description: "Headless commerce engine REST API. Includes core and plugin endpoints.",
      },
      tags: [
        // ── Entity aliases (generated from config.entities[type].alias) ──
        ...Object.entries(config.entities ?? {})
          .filter(([, cfg]) => cfg.alias)
          .map(([type, cfg]) => {
            const name = cfg.alias!.charAt(0).toUpperCase() + cfg.alias!.slice(1);
            return { name, description: `Ergonomic alias for ${type} entities — CRUD, variants, attributes` };
          }),
        // ── Storefront ──
        { name: "Catalog", description: "Products, categories, brands, variants, and option types (unified entity API)" },
        { name: "Search", description: "Full-text search and typeahead suggestions" },
        { name: "Pricing", description: "Base prices, price modifiers, and customer group pricing" },
        { name: "Carts", description: "Shopping cart lifecycle — create, add items, update quantities" },
        { name: "Checkout", description: "Convert a cart into a paid order" },
        { name: "Promotions", description: "Discount codes, validation, and usage tracking" },
        // ── Admin ──
        { name: "Orders", description: "Order management — list, detail, status transitions, fulfillments" },
        { name: "Customers", description: "Customer profiles, addresses, groups, and order history" },
        { name: "Inventory", description: "Stock levels, warehouse management, adjustments, and reservations" },
        { name: "Media", description: "File uploads, entity attachments, and signed URLs" },
        { name: "Payments", description: "Payment provider webhooks and event processing" },
        // ── Operations ──
        { name: "Webhooks", description: "Outbound webhook endpoint registration and management" },
        { name: "Audit", description: "Immutable audit log — who changed what and when" },
        { name: "Admin Jobs", description: "Background job queue — view failed jobs and retry" },
      ],
    });

    // Serve enriched spec with x-tagGroups vendor extension (Scalar/Redocly sidebar grouping)
    const aliasTags = Object.values(config.entities ?? {})
      .filter((cfg) => cfg.alias)
      .map((cfg) => cfg.alias!.charAt(0).toUpperCase() + cfg.alias!.slice(1));
    const tagGroups = [
      ...(aliasTags.length > 0 ? [{ name: "Quick Access", tags: aliasTags }] : []),
      { name: "Storefront", tags: ["Catalog", "Search", "Pricing", "Carts", "Checkout", "Promotions"] },
      { name: "Admin", tags: ["Orders", "Customers", "Inventory", "Media", "Payments"] },
      { name: "Operations", tags: ["Webhooks", "Audit", "Admin Jobs"] },
    ];
    app.get("/api/doc-ext", (c) => {
      const spec = app.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "UnifiedCommerce API", version: config.version ?? "0.0.1" } });
      return c.json({ ...spec, "x-tagGroups": tagGroups });
    });
  } else {
    app.get("/api/doc", (c) => c.json({ error: { code: "NOT_FOUND", message: "Not found." } }, 404));
  }

  // ─── Job Queue ───────────────────────────────────────────────────────
  // Background job processing: webhook delivery, stale-job reaper, scheduled work.
  //
  // Three runner strategies (inspired by Payload CMS):
  //   1. autorun: in-process polling (long-running servers)
  //   2. GET /api/jobs/run: cron endpoint (serverless — Vercel, Cloudflare)
  //   3. runPendingJobs() export (custom worker process)

  const { runPendingJobs } = await import("../kernel/jobs/runner.js");
  const { runStaleJobReaper, getJobReapThresholdMs, getJobsReaperIntervalMs } =
    await import("../kernel/jobs/reaper.js");
  const taskMap = new Map<string, unknown>();
  for (const task of config.jobs?.tasks ?? []) {
    const t = task as { slug?: string; name?: string };
    taskMap.set(t.slug ?? t.name ?? "", task);
  }

  const jobLogger = {
    info: (msg: string, data?: unknown) => logger.info(data != null ? { data } : {}, msg),
    warn: (msg: string, data?: unknown) => logger.warn(data != null ? { data } : {}, msg),
    error: (msg: string, data?: unknown) => logger.error(data != null ? { data } : {}, msg),
  };

  let lastStaleJobReaperAt = 0;

  const maybeRunStaleJobReaper = async () => {
    const interval = getJobsReaperIntervalMs();
    const now = Date.now();
    if (now - lastStaleJobReaperAt < interval) return;
    lastStaleJobReaperAt = now;
    try {
      await runStaleJobReaper(
        kernel.database.db as DrizzleDatabase,
        getJobReapThresholdMs(),
        jobLogger,
      );
    } catch (err) {
      logger.error({ err }, "Stale job reaper failed");
    }
  };

  const runJobs = async (queue?: string, limit?: number) => {
    await maybeRunStaleJobReaper();
    return runPendingJobs({
      db: kernel.database.db as DrizzleDatabase,
      tasks: taskMap as Parameters<typeof runPendingJobs>[0]["tasks"],
      queue: queue ?? "default",
      limit: limit ?? 10,
      logger: jobLogger,
      services: kernel.services as Parameters<typeof runPendingJobs>[0]["services"],
    });
  };

  // Strategy 1: Built-in cron endpoint for serverless deployments.
  // Point Vercel Cron or Cloudflare Cron Trigger at GET /api/jobs/run
  // Optional query params: ?queue=emails&limit=20
  app.get("/api/jobs/run", async (c) => {
    // Always require admin — cron triggers must authenticate
    const actor = c.get("actor") as { permissions?: string[] } | null;
    if (!actor?.permissions?.includes("*:*")) {
      return c.json({ error: { code: "FORBIDDEN", message: "Job runner requires admin access" } }, 403);
    }

    const queue = c.req.query("queue") ?? "default";
    const limit = parseInt(c.req.query("limit") ?? "10", 10);

    try {
      const result = await runJobs(queue, limit);
      return c.json({ data: result });
    } catch (err) {
      logger.error({ err }, "Job runner endpoint failed");
      return c.json({ error: { code: "INTERNAL_ERROR", message: "Job processing failed" } }, 500);
    }
  });

  // Strategy 2: In-process polling for long-running servers (ECS, Cloud Run, Docker).
  // Enable via config.jobs.autorun.enabled = true
  if (config.jobs?.autorun?.enabled) {
    const intervalMs = config.jobs.autorun.intervalMs ?? 10_000;

    const jobInterval = setInterval(async () => {
      try {
        await runJobs();
      } catch (err) {
        logger.error({ err }, "Job runner iteration failed");
      }
    }, intervalMs);

    const cleanup = () => clearInterval(jobInterval);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    logger.info({ intervalMs }, "Job queue autorun started (in-process polling)");
  } else {
    logger.info(
      "Job queue autorun disabled. Use GET /api/jobs/run for serverless cron, " +
      "or set config.jobs.autorun.enabled = true for in-process polling.",
    );
  }

  const dispatchFetch = app.fetch.bind(app);
  app.fetch = ((input: RequestInfo | URL, env?: unknown, executionCtx?: unknown) => {
    const req = input instanceof Request ? input : new Request(input);
    const rewritten = rewriteCommerceAliasRequest(req, config.entities);
    return dispatchFetch(rewritten as Request, env as never, executionCtx as never);
  }) as typeof app.fetch;

  // `runJobs` triggers one job-runner tick. On Cloudflare Workers, call it
  // from `scheduled()` so cron triggers drive the queue without an in-process
  // setInterval (which can't outlive a request on Workers):
  //
  //   // wrangler.toml
  //   [triggers]
  //   crons = ["*/5 * * * *"]
  //
  //   // worker.ts
  //   export default {
  //     fetch: (req, env, ctx) => server.app.fetch(req, env, ctx),
  //     scheduled: (_event, env, ctx) => ctx.waitUntil(server.runJobs()),
  //   };
  return { app, kernel, logger, commerce, runJobs };
}
