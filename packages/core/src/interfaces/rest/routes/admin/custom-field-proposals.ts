import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../../runtime/kernel.js";
import {
  listCustomFieldProposalsRoute,
} from "../../schemas/admin-custom-field-proposals.js";
import {
  type AppEnv,
  errorBody,
  mapErrorToStatus,
  parsePagination,
  requirePerm,
} from "../../utils.js";

export function adminCustomFieldProposalRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/custom-field-proposals", requirePerm("catalog:update"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(listCustomFieldProposalsRoute, async (c) => {
    const pagination = parsePagination(c.req.query());
    const entityType = c.req.query("entityType");
    const result = await kernel.services.catalog.listProposedCustomFields(
      { pagination, ...(entityType !== undefined ? { entityType } : {}) },
      c.get("actor"),
    );
    if (!result.ok) return c.json(errorBody(result.error), mapErrorToStatus(result.error));
    return c.json({
      data: {
        items: result.value.items,
        total: result.value.total,
        page: pagination.page,
        limit: pagination.limit,
      },
    });
  });

  return router;
}
