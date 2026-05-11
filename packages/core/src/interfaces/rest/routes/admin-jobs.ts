import { OpenAPIHono } from "@hono/zod-openapi";
import { eq, and, desc } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Kernel } from "../../../runtime/kernel.js";
import { commerceJobs } from "../../../kernel/jobs/schema.js";
import { listFailedJobsRoute, retryJobRoute } from "../schemas/admin-jobs.js";
import { type AppEnv, requirePerm } from "../utils.js";
import { resolveOrgId } from "../../../auth/org.js";

type Db = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export function adminJobRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();
  const db = kernel.database.db as Db;

  router.use("/jobs/failed", requirePerm("jobs:admin"));

  router.openapi(listFailedJobsRoute, async (c) => {
    const actor = c.get("actor");
    const orgId = resolveOrgId(actor);
    const limit = Math.min(Number(c.req.query("limit") ?? "50"), 100);
    const conditions = [eq(commerceJobs.status, "failed")];
    // Scope to org unless wildcard admin
    if (!actor?.permissions?.includes("*:*")) {
      conditions.push(eq(commerceJobs.organizationId, orgId));
    }
    const failed = await db.select()
      .from(commerceJobs)
      .where(and(...conditions))
      .orderBy(desc(commerceJobs.completedAt))
      .limit(limit);
    return c.json({ data: failed });
  });

  router.use("/jobs/:id/retry", requirePerm("jobs:admin"));

  // @ts-expect-error -- openapi handler union return type
  router.openapi(retryJobRoute, async (c) => {
    const actor = c.get("actor");
    const orgId = resolveOrgId(actor);
    const id = c.req.param("id");
    const conditions = [eq(commerceJobs.id, id)];
    // Scope to org unless wildcard admin
    if (!actor?.permissions?.includes("*:*")) {
      conditions.push(eq(commerceJobs.organizationId, orgId));
    }
    const result = await db.update(commerceJobs)
      .set({ status: "pending", attempts: 0, error: null, waitUntil: null, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    if (result.length === 0) {
      return c.json({ error: { code: "NOT_FOUND", message: "Job not found." } }, 404);
    }
    return c.json({ data: { retried: true } });
  });

  return router;
}
