import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { UOMService } from "../services/uom-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildUOMRoutes(
  service: UOMService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Units of Measure", "/uom", ctx);

  r.post("/units").summary("Create unit").permission("uom:admin")
    .input(z.object({ code: z.string().min(1).max(20), name: z.string().min(1), category: z.enum(["weight", "volume", "length", "count", "area", "time"]), isBaseUnit: z.boolean().optional() }))
    .handler(async ({ input, orgId }) => {
      const body = input as { code: string; name: string; category: "weight" | "volume" | "length" | "count" | "area" | "time"; isBaseUnit?: boolean };
      const result = await service.createUnit(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/units").summary("List units").permission("uom:read")
    .query(z.object({ category: z.enum(["weight", "volume", "length", "count", "area", "time"]).optional() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { category?: "weight" | "volume" | "length" | "count" | "area" | "time" };
      const result = await service.listUnits(orgId, q.category);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/conversions").summary("Create conversion").permission("uom:admin")
    .input(z.object({ fromUnitId: z.string().uuid(), toUnitId: z.string().uuid(), factor: z.number().int().positive() }))
    .handler(async ({ input, orgId }) => {
      const body = input as { fromUnitId: string; toUnitId: string; factor: number };
      const result = await service.createConversion(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/conversions").summary("List conversions").permission("uom:read")
    .handler(async ({ orgId }) => {
      const result = await service.listConversions(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/convert").summary("Convert quantity").permission("uom:read")
    .input(z.object({ fromUnitId: z.string().uuid(), toUnitId: z.string().uuid(), quantity: z.number().positive() }))
    .handler(async ({ input, orgId }) => {
      const body = input as { fromUnitId: string; toUnitId: string; quantity: number };
      const result = await service.convert(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/entities/{id}/uom").summary("Set entity UOM").permission("uom:admin")
    .input(z.object({ purchaseUomId: z.string().uuid(), stockUomId: z.string().uuid(), saleUomId: z.string().uuid(), yieldPercentage: z.number().int().min(1).max(100).optional() }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { purchaseUomId: string; stockUomId: string; saleUomId: string; yieldPercentage?: number };
      const result = await service.setEntityUom(orgId, { entityId: params.id!, ...body });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/entities/{id}/uom").summary("Get entity UOM").permission("uom:read")
    .handler(async ({ params, orgId }) => {
      const result = await service.getEntityUom(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
