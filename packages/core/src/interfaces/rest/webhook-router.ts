/**
 * webhookRouter() — route builder for external webhook receivers.
 *
 * Unlike router() which uses UC authentication (.auth(), .permission()),
 * webhookRouter() uses HMAC signature verification. This is for routes
 * that receive callbacks from external services (Shopify, WooCommerce,
 * Stripe, BNPL providers) that authenticate via provider-specific signatures.
 *
 * Provides typed access to kernel.services, kernel.database.db, and
 * kernel.logger without casting through `unknown`.
 *
 * Usage:
 *
 *   import { webhookRouter } from "@porulle/core";
 *
 *   export function createMyWebhookRoutes(kernel: Kernel) {
 *     const { app, services, db, logger } = webhookRouter(kernel);
 *
 *     app.post("/product-updated", async (c) => {
 *       const body = await c.req.json();
 *       await services.catalog.update(body.id, { ... }, systemActor);
 *       return c.json({ status: "ok" });
 *     });
 *
 *     return app;
 *   }
 */

import { Hono } from "hono";
import type { Kernel } from "../../runtime/kernel.js";

export interface WebhookRouterResult {
  /** Raw Hono app — mount routes on this. No UC auth middleware attached. */
  app: Hono;
  /** Kernel services (catalog, inventory, orders, etc.). Typed properly. */
  services: Kernel["services"];
  /** Drizzle database instance for direct queries. */
  db: Kernel["database"]["db"];
  /** Structured Pino logger. */
  logger: Kernel["logger"];
}

export function webhookRouter(kernel: Kernel): WebhookRouterResult {
  return {
    app: new Hono(),
    services: kernel.services,
    db: kernel.database.db,
    logger: kernel.logger,
  };
}
