import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { TransferService } from "../services/transfer-service.js";
import type { WastageService } from "../services/wastage-service.js";
import type { ReconciliationService } from "../services/reconciliation-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildWarehouseRoutes(
  transferSvc: TransferService, wastageSvc: WastageService, recSvc: ReconciliationService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Warehouse", "/warehouse", ctx);

  // Transfers
  r.post("/transfers").summary("Create stock transfer").permission("warehouse:operate")
    .input(z.object({
      fromWarehouseId: z.string().uuid(), toWarehouseId: z.string().uuid(), type: z.enum(["requisition", "direct", "return"]).optional(), notes: z.string().optional(),
      items: z.array(z.object({ entityId: z.string().uuid(), variantId: z.string().uuid().optional(), itemName: z.string(), quantityRequested: z.number().int().positive(), batchNumber: z.string().optional() })).min(1),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as Parameters<typeof transferSvc.create>[1];
      const result = await transferSvc.create(orgId, { ...body, requestedBy: actor!.userId });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/transfers").summary("List transfers").permission("warehouse:read")
    .query(z.object({ status: z.string().optional() }))
    .handler(async ({ query, orgId }) => {
      const result = await transferSvc.list(orgId, (query as { status?: string }).status);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/transfers/{id}").summary("Get transfer with items").permission("warehouse:read")
    .handler(async ({ params, orgId }) => {
      const result = await transferSvc.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/transfers/{id}/approve").summary("Approve transfer").permission("warehouse:admin")
    .handler(async ({ params, actor, orgId }) => {
      const result = await transferSvc.approve(orgId, params.id!, actor!.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/transfers/{id}/dispatch").summary("Dispatch transfer").permission("warehouse:operate")
    .handler(async ({ params, orgId }) => {
      const result = await transferSvc.dispatch(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/transfers/{id}/receive").summary("Receive transfer").permission("warehouse:operate")
    .input(z.object({ items: z.array(z.object({ itemId: z.string().uuid(), quantityReceived: z.number().int() })).min(1) }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { items: Array<{ itemId: string; quantityReceived: number }> };
      const result = await transferSvc.receive(orgId, params.id!, body.items);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // Wastage
  r.post("/wastage").summary("Create wastage note").permission("warehouse:operate")
    .input(z.object({
      warehouseId: z.string().uuid(), type: z.enum(["spoilage", "damage", "expiry", "theft", "prep_waste", "other"]), notes: z.string().optional(),
      items: z.array(z.object({ entityId: z.string().uuid(), variantId: z.string().uuid().optional(), itemName: z.string(), quantity: z.number().int().positive(), unitCost: z.number().int(), reason: z.string().optional(), batchNumber: z.string().optional() })).min(1),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as Parameters<typeof wastageSvc.create>[1];
      const result = await wastageSvc.create(orgId, { ...body, recordedBy: actor!.userId });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/wastage").summary("List wastage notes").permission("warehouse:read")
    .handler(async ({ orgId }) => {
      const result = await wastageSvc.list(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/wastage/{id}/approve").summary("Approve wastage").permission("warehouse:admin")
    .handler(async ({ params, actor, orgId }) => {
      const result = await wastageSvc.approve(orgId, params.id!, actor!.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // Reconciliation
  r.post("/reconciliations").summary("Create stock reconciliation").permission("warehouse:operate")
    .input(z.object({
      warehouseId: z.string().uuid(),
      items: z.array(z.object({ entityId: z.string().uuid(), variantId: z.string().uuid().optional(), itemName: z.string(), systemQuantity: z.number().int(), physicalQuantity: z.number().int(), notes: z.string().optional() })).min(1),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as Parameters<typeof recSvc.create>[1];
      const result = await recSvc.create(orgId, { ...body, countedBy: actor!.userId });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/reconciliations").summary("List reconciliations").permission("warehouse:read")
    .handler(async ({ orgId }) => {
      const result = await recSvc.list(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/reconciliations/{id}").summary("Get reconciliation with items").permission("warehouse:read")
    .handler(async ({ params, orgId }) => {
      const result = await recSvc.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/reconciliations/{id}/submit").summary("Submit reconciliation").permission("warehouse:operate")
    .handler(async ({ params, orgId }) => {
      const result = await recSvc.submit(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/reconciliations/{id}/approve").summary("Approve reconciliation").permission("warehouse:admin")
    .handler(async ({ params, actor, orgId }) => {
      const result = await recSvc.approve(orgId, params.id!, actor!.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
