import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { LookupService } from "../services/lookup-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildLookupRoutes(
  service: LookupService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Lookup", "/pos/lookup", ctx);

  r.get("/barcode/{code}")
    .summary("Lookup by barcode")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.byBarcode(orgId, params.code!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/sku/{sku}")
    .summary("Lookup by SKU")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.bySku(orgId, params.sku!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/search")
    .summary("Search items")
    .permission("pos:operate")
    .query(z.object({
      q: z.string().min(1).max(200),
    }))
    .handler(async ({ query, orgId }) => {
      const q = query as { q: string };
      const result = await service.search(orgId, q.q);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
