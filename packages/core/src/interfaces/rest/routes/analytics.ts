import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import { getReportRoute, listReportsRoute } from "../schemas/analytics.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus, requirePerm } from "../utils.js";

export function analyticsRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/reports", requirePerm("analytics:read"));
  router.use("/reports/:name", requirePerm("analytics:read"));

  router.openapi(listReportsRoute, (c) => {
    return c.json({ data: kernel.services.analytics.listReports() });
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(getReportRoute, async (c) => {
    const { date, from, to } = c.req.valid("query");
    const result = await kernel.services.analytics.getReport(
      c.req.param("name"),
      {
        ...(date !== undefined ? { date } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      },
      c.get("actor"),
    );
    if (!result.ok) return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
    return c.json({ data: result.value });
  });

  return router;
}
