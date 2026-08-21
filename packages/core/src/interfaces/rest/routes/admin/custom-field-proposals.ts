import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../../runtime/kernel.js";
import { resolveOrgIdForCommerce } from "../../../../auth/org.js";
import {
  listCustomFieldProposalsRoute,
} from "../../schemas/admin-custom-field-proposals.js";
import {
  type AppEnv,
  parsePagination,
  requirePerm,
} from "../../utils.js";

export function adminCustomFieldProposalRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  router.use("/custom-field-proposals", requirePerm("catalog:update"));

  router.openapi(listCustomFieldProposalsRoute, async (c) => {
    const pagination = parsePagination(c.req.query());
    const entityType = c.req.query("entityType");
    const result = await kernel.services.catalog.repository.listProposedCustomFields(
      resolveOrgIdForCommerce(c.get("actor"), kernel.config),
      pagination,
      entityType !== undefined ? { entityType } : undefined,
    );
    return c.json({
      data: {
        items: result.items,
        total: result.total,
        page: pagination.page,
        limit: pagination.limit,
      },
    });
  });

  return router;
}
