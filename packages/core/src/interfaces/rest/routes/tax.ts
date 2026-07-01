import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import {
  createTaxRateRoute,
  listTaxRatesRoute,
  updateTaxRateRoute,
  deleteTaxRateRoute,
} from "../schemas/tax.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function taxRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/rates", requirePerm("tax:manage"));
  router.use("/rates/:id", requirePerm("tax:manage"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(createTaxRateRoute, async (c) => {
    const result = await kernel.services.tax.createTaxRate(c.req.valid("json"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value }, 201);
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listTaxRatesRoute, async (c) => {
    const result = await kernel.services.tax.listTaxRates(c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(updateTaxRateRoute, async (c) => {
    const result = await kernel.services.tax.updateTaxRate(
      c.req.param("id"),
      c.req.valid("json"),
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(deleteTaxRateRoute, async (c) => {
    const result = await kernel.services.tax.deleteTaxRate(c.req.param("id"), c.get("actor"));
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  return router;
}
