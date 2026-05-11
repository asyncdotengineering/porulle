import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import { listAuditRoute, listEntityAuditRoute } from "../schemas/audit.js";
import { type AppEnv, requirePerm } from "../utils.js";
import { resolveOrgId } from "../../../auth/org.js";

export function auditRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  /**
   * GET /api/audit
   * List audit entries with optional filters.
   */
  router.use("/", requirePerm("audit:read"));

  router.openapi(listAuditRoute, async (c) => {
    const actor = c.get("actor");
    const orgId = resolveOrgId(actor);
    const entries = await kernel.services.audit.list({
      organizationId: orgId,
      entityType: c.req.query("entityType"),
      entityId: c.req.query("entityId"),
      event: c.req.query("event"),
      actorId: c.req.query("actorId"),
      from: c.req.query("from") ? new Date(c.req.query("from")!) : undefined,
      to: c.req.query("to") ? new Date(c.req.query("to")!) : undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : 50,
    });
    return c.json({ data: entries });
  });

  /**
   * GET /api/audit/:entityType/:entityId
   * List audit history for a specific entity.
   */
  router.use("/:entityType/:entityId", requirePerm("audit:read"));

  router.openapi(listEntityAuditRoute, async (c) => {
    const actor = c.get("actor");
    const orgId = resolveOrgId(actor);
    const entries = await kernel.services.audit.listForEntity({
      organizationId: orgId,
      entityType: c.req.param("entityType"),
      entityId: c.req.param("entityId"),
    });
    return c.json({ data: entries });
  });

  return router;
}
