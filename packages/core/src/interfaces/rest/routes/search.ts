import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import { searchRoute, suggestRoute } from "../schemas/search.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus } from "../utils.js";

export function searchRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // @ts-expect-error -- openapi handler union return type
  router.openapi(searchRoute, async (c) => {
    try {
      const q = c.req.query("q") ?? "";
      const type = c.req.query("type");
      const category = c.req.query("category");
      const brand = c.req.query("brand");
      const status = c.req.query("status");
      const page = Number.parseInt(c.req.query("page") ?? "1", 10);
      const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
      const facets = (c.req.query("facets") ?? "")
        .split(",")
        .map((facet) => facet.trim())
        .filter(Boolean);

      const result = await kernel.services.search.query({
        query: q,
        page,
        limit,
        filters: {
          ...(type ? { type } : {}),
          ...(category ? { category } : {}),
          ...(brand ? { brand } : {}),
          ...(status ? { status } : {}),
        },
        ...(facets.length > 0 ? { facets } : {}),
      }, { actor: c.get("actor"), tx: null, requestId: "" });

      if (!result.ok) {
        return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
      }

      return c.json({
        data: result.value.hits,
        meta: {
          total: result.value.total,
          page: result.value.page,
          limit: result.value.limit,
          facets: result.value.facets,
        },
      });
    } catch (error) {
      console.error("[search] Route handler failed:", error instanceof Error ? error.message : error);
      return c.json({ data: [], meta: { total: 0, page: 1, limit: 20, facets: {} } });
    }
  });

  // @ts-expect-error -- openapi handler union return type
  router.openapi(suggestRoute, async (c) => {
    try {
      const prefix = c.req.query("prefix") ?? "";
      const type = c.req.query("type");
      const limit = Number.parseInt(c.req.query("limit") ?? "10", 10);

      const result = await kernel.services.search.suggest({
        prefix,
        ...(type ? { type } : {}),
        limit,
      }, { actor: c.get("actor"), tx: null, requestId: "" });

      if (!result.ok) {
        return c.json(mapErrorToResponse(result.error), mapErrorToStatus(result.error));
      }

      return c.json({ data: result.value });
    } catch (error) {
      console.error("[search] Suggest route failed:", error instanceof Error ? error.message : error);
      return c.json({ data: [] });
    }
  });

  return router;
}
