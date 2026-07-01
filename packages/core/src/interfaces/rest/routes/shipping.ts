import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import {
  createShippingZoneRoute,
  listShippingZonesRoute,
  updateShippingZoneRoute,
  deleteShippingZoneRoute,
  createShippingRateRoute,
  listShippingRatesRoute,
  updateShippingRateRoute,
  deleteShippingRateRoute,
} from "../schemas/shipping.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function shippingRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/zones", requirePerm("shipping:manage"));
  router.use("/zones/:id", requirePerm("shipping:manage"));
  router.use("/rates", requirePerm("shipping:manage"));
  router.use("/rates/:id", requirePerm("shipping:manage"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createShippingZoneRoute, async (c) => {
    const result = await kernel.services.shipping.createZone(c.req.valid("json"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listShippingZonesRoute, async (c) => {
    const result = await kernel.services.shipping.listZones(c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateShippingZoneRoute, async (c) => {
    const result = await kernel.services.shipping.updateZone(
      c.req.param("id"),
      c.req.valid("json"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteShippingZoneRoute, async (c) => {
    const result = await kernel.services.shipping.deleteZone(c.req.param("id"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createShippingRateRoute, async (c) => {
    const result = await kernel.services.shipping.createRate(c.req.valid("json"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listShippingRatesRoute, async (c) => {
    const zoneId = c.req.query("zoneId");
    const result = await kernel.services.shipping.listRates(
      zoneId !== undefined ? { zoneId } : undefined,
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateShippingRateRoute, async (c) => {
    const result = await kernel.services.shipping.updateRate(
      c.req.param("id"),
      c.req.valid("json"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteShippingRateRoute, async (c) => {
    const result = await kernel.services.shipping.deleteRate(c.req.param("id"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  return router;
}
