import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ProductionService } from "../services/production-service.js";
import type { ProductionOrderService } from "../services/production-order-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildProductionRoutes(
  bomSvc: ProductionService,
  orderSvc: ProductionOrderService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Production", "/production", ctx);

  // --- BOM Routes ---

  r.post("/boms").summary("Create BOM").permission("production:admin")
    .input(z.object({
      entityId: z.string().uuid(),
      name: z.string().min(1),
      yieldQuantity: z.number().int().positive().optional(),
      yieldUomId: z.string().uuid().optional(),
      level: z.number().int().min(0).optional(),
      items: z.array(z.object({
        entityId: z.string().uuid(),
        itemName: z.string().min(1),
        quantity: z.number().int().positive(),
        unitCost: z.number().int().min(0),
        uomId: z.string().uuid().optional(),
        isSubAssembly: z.boolean().optional(),
        subBomId: z.string().uuid().optional(),
      })).min(1),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as {
        entityId: string; name: string; yieldQuantity?: number; yieldUomId?: string; level?: number;
        items: Array<{ entityId: string; itemName: string; quantity: number; unitCost: number; uomId?: string; isSubAssembly?: boolean; subBomId?: string }>;
      };
      const result = await bomSvc.createBOM(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/boms").summary("List BOMs").permission("production:read")
    .handler(async ({ orgId }) => {
      const result = await bomSvc.listBOMs(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/boms/{id}").summary("Get BOM").permission("production:read")
    .handler(async ({ params, orgId }) => {
      const result = await bomSvc.getBOM(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/boms/{id}/items").summary("Add item to BOM").permission("production:admin")
    .input(z.object({
      entityId: z.string().uuid(),
      itemName: z.string().min(1),
      quantity: z.number().int().positive(),
      unitCost: z.number().int().min(0),
      uomId: z.string().uuid().optional(),
      isSubAssembly: z.boolean().optional(),
      subBomId: z.string().uuid().optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as {
        entityId: string; itemName: string; quantity: number; unitCost: number;
        uomId?: string; isSubAssembly?: boolean; subBomId?: string;
      };
      const result = await bomSvc.addBOMItem(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/boms/{id}/cost-rollup").summary("Cost rollup").permission("production:admin")
    .handler(async ({ params, orgId }) => {
      const result = await bomSvc.costRollup(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/boms/{id}/explode").summary("BOM explosion").permission("production:read")
    .input(z.object({ quantity: z.number().int().positive() }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { quantity: number };
      const result = await bomSvc.explode(orgId, params.id!, body.quantity);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // --- Production Order Routes ---

  r.post("/orders").summary("Create production order").permission("production:create")
    .input(z.object({
      bomId: z.string().uuid(),
      entityId: z.string().uuid(),
      quantity: z.number().int().positive(),
      warehouseId: z.string().uuid(),
      plannedDate: z.string(),
      notes: z.string().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { bomId: string; entityId: string; quantity: number; warehouseId: string; plannedDate: string; notes?: string };
      const result = await orderSvc.create(orgId, {
        ...body,
        plannedDate: new Date(body.plannedDate),
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/orders").summary("List production orders").permission("production:read")
    .query(z.object({ status: z.enum(["planned", "in_progress", "completed", "cancelled"]).optional() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { status?: string };
      const result = await orderSvc.list(orgId, q.status);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/orders/{id}").summary("Get production order").permission("production:read")
    .handler(async ({ params, orgId }) => {
      const result = await orderSvc.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/orders/{id}/start").summary("Start production order").permission("production:create")
    .input(z.object({ producedBy: z.string().min(1) }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { producedBy: string };
      const result = await orderSvc.start(orgId, params.id!, body.producedBy);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/orders/{id}/consume").summary("Record consumption").permission("production:create")
    .input(z.object({
      items: z.array(z.object({
        entityId: z.string().uuid(),
        variantId: z.string().uuid().optional(),
        plannedQuantity: z.number().int().min(0),
        actualQuantity: z.number().int().min(0),
        uomId: z.string().uuid().optional(),
        unitCost: z.number().int().min(0),
        batchNumber: z.string().optional(),
      })).min(1),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as {
        items: Array<{
          entityId: string; variantId?: string; plannedQuantity: number;
          actualQuantity: number; uomId?: string; unitCost: number; batchNumber?: string;
        }>;
      };
      const result = await orderSvc.recordConsumption(orgId, params.id!, body.items);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/orders/{id}/complete").summary("Complete production order").permission("production:create")
    .handler(async ({ params, orgId }) => {
      const result = await orderSvc.complete(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/orders/{id}/cancel").summary("Cancel production order").permission("production:admin")
    .handler(async ({ params, orgId }) => {
      const result = await orderSvc.cancel(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
