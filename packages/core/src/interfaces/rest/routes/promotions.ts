import { OpenAPIHono } from "@hono/zod-openapi";
import { rateLimiter } from "hono-rate-limiter";
import type { Kernel } from "../../../runtime/kernel.js";
import { createPromotionRoute, updatePromotionRoute, validatePromotionRoute, deactivatePromotionRoute, listPromotionsRoute } from "../schemas/promotions.js";
import type { PromotionStatusFilter } from "../../../modules/promotions/service.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";
import { resolveOrgId } from "../../../auth/org.js";

export function promotionRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // Rate limit promo code validation — prevents brute-force code enumeration
  router.use(
    "/validate",
    rateLimiter({
      windowMs: 60 * 1000,
      limit: 10,
      keyGenerator: (c) => {
        // Node.js Request has a socket property; Hono types it as unknown.
        const socket = (c.req.raw as { socket?: { remoteAddress?: string } }).socket;
        return socket?.remoteAddress ?? "unknown";
      },
    }),
  );

  router.use("/", requirePerm("promotions:manage"));

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (201 | 400 | 422). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(createPromotionRoute, async (c) => {
    const body = c.req.valid("json");
    const actor = c.get("actor");
    const result = await kernel.services.promotions.create(body, actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value }, 201);
  });

  // List promotions — supports ?status= filter (active/inactive/expired/scheduled)
  // @ts-expect-error -- openapi handler union return type
  router.openapi(listPromotionsRoute, async (c) => {
    const actor = c.get("actor");
    const status = c.req.query("status") as PromotionStatusFilter | undefined;
    const result = await kernel.services.promotions.list(
      status ? { status } : undefined,
      actor,
    );
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (200 | 400 | 404). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(validatePromotionRoute, async (c) => {
    const payload = c.req.valid("json");
    const actor = c.get("actor");
    const orgId = resolveOrgId(actor);

    // Apply (not just validate) so the response carries the authoritative
    // discount the cart would receive — the same computation checkout runs.
    // Returning only the promotion forces callers to re-derive the amount, which
    // drifts from checkout and shows customers a wrong number. apply() still
    // Err's on an invalid / inapplicable code (it validates first).
    const result = await kernel.services.promotions.apply(payload.code, {
      orgId,
      currency: payload.currency,
      subtotal: payload.subtotal,
      lineItems: payload.lineItems,
      ...(payload.customerId !== undefined ? { customerId: payload.customerId } : {}),
      ...(payload.customerGroupIds !== undefined ? { customerGroupIds: payload.customerGroupIds } : {}),
    });

    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }

    return c.json({ data: result.value });
  });

  // Guard inline (not via router.use("/:id")) because a "/:id" middleware
  // would also match single-segment routes like POST /validate.
  router.use("/:id", async (c, next) => {
    if (c.req.method !== "PATCH") return next();
    return requirePerm("promotions:manage")(c, next);
  });

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (200 | 400 | 404 | 422). The route definition
  // documents the contract; the handler returns dynamic status.
  router.openapi(updatePromotionRoute, async (c) => {
    const body = c.req.valid("json");
    const actor = c.get("actor");
    const orgId = resolveOrgId(actor);
    const result = await kernel.services.promotions.update(orgId, c.req.param("id"), body, actor);
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value });
  });

  router.use("/:id/deactivate", requirePerm("promotions:manage"));

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (200 | 400 | 404). The route definition documents the
  // contract; the handler returns dynamic status.
  router.openapi(deactivatePromotionRoute, async (c) => {
    const actor = c.get("actor");
    const orgId = resolveOrgId(actor);
    const result = await kernel.services.promotions.deactivate(orgId, c.req.param("id"));
    if (!result.ok) {
      return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    }
    return c.json({ data: result.value });
  });

  return router;
}
