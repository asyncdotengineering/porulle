import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { sql } from "drizzle-orm";
import type { Kernel } from "../../runtime/kernel.js";
import type { AppEnv } from "./utils.js";
import { mapErrorToResponse } from "../../kernel/error-mapper.js";
import { catalogRoutes } from "./routes/catalog.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { mediaRoutes } from "./routes/media.js";
import { cartRoutes } from "./routes/carts.js";
import { checkoutRoutes } from "./routes/checkout.js";
import { orderRoutes } from "./routes/orders.js";
import { paymentRoutes } from "./routes/payments.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { pricingRoutes } from "./routes/pricing.js";
import { promotionRoutes } from "./routes/promotions.js";
import { searchRoutes } from "./routes/search.js";
import { auditRoutes } from "./routes/audit.js";
import { adminJobRoutes } from "./routes/admin-jobs.js";
import { compensationFailureAdminRoutes } from "./routes/admin/compensation-failures.js";
import { adminPermissionsRoutes } from "./routes/admin/permissions.js";
import { adminStaffRoutes } from "./routes/admin/staff.js";
import { customerRoutes } from "./routes/customers.js";
import { shippingRoutes } from "./routes/shipping.js";
import { taxRoutes } from "./routes/tax.js";
export function createRestRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>({
    // Standardize Zod validation error responses across all routes
    defaultHook: (result, c) => {
      if (!result.success) {
        const isProd = process.env.NODE_ENV === "production";
        return c.json({
          error: {
            code: "VALIDATION_FAILED",
            // In production: generic message. In dev: detailed field errors.
            message: isProd
              ? "Invalid input."
              : result.error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; "),
          },
        }, 422);
      }
    },
  });

  // Global error boundary — catches unhandled exceptions from any route handler.
  router.onError((error, c) => {
    const isProd = process.env.NODE_ENV === "production";
    const { body, status } = mapErrorToResponse(error, isProd);
    return c.json(body, status);
  });

  // F5: Health check with database probe — minimal info for load balancers
  router.get("/health", async (c) => {
    try {
      const db = kernel.database.db;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("health check timeout")), 5000),
      );
      await Promise.race([
        (db as { execute: (q: unknown) => Promise<unknown> }).execute(sql`SELECT 1`),
        timeout,
      ]);
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "down" }, 503);
    }
  });

  // ─── Domain routes ──────────────────────────────────────────────────
  router.route("/catalog", catalogRoutes(kernel));
  router.route("/inventory", inventoryRoutes(kernel));
  router.route("/media", mediaRoutes(kernel));
  router.route("/carts", cartRoutes(kernel));
  router.route("/checkout", checkoutRoutes(kernel));
  router.route("/orders", orderRoutes(kernel));
  router.route("/payments", paymentRoutes(kernel));
  router.route("/webhooks", webhookRoutes(kernel));
  router.route("/pricing", pricingRoutes(kernel));
  router.route("/shipping", shippingRoutes(kernel));
  router.route("/tax", taxRoutes(kernel));
  router.route("/promotions", promotionRoutes(kernel));
  router.route("/search", searchRoutes(kernel));
  router.route("/customers", customerRoutes(kernel));
  router.route("/audit", auditRoutes(kernel));
  router.route("/admin", adminJobRoutes(kernel));
  router.route("/admin", compensationFailureAdminRoutes(kernel));
  router.route("/admin", adminPermissionsRoutes(kernel));
  router.route("/admin", adminStaffRoutes(kernel));

  // API Reference (Scalar) — disabled in production unless config.exposeOpenApiSpec is true
  const exposeSpec = kernel.config.exposeOpenApiSpec ?? (process.env.NODE_ENV !== "production");
  if (exposeSpec) {
    router.get(
      "/reference",
      Scalar({
        url: "/api/doc-ext",
        theme: "kepler",
        layout: "modern",
        darkMode: true,
        hideModels: true,
        tagsSorter: "alpha",
        defaultHttpClient: { targetKey: "js", clientKey: "fetch" },
        metaData: { title: "UnifiedCommerce API Reference" },
      }),
    );
  }

  return router;
}
