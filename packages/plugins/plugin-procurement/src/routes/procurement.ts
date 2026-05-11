import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { SupplierService } from "../services/supplier-service.js";
import type { PurchaseOrderService } from "../services/po-service.js";
import type { GRNService } from "../services/grn-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildProcurementRoutes(
  supplierSvc: SupplierService, poSvc: PurchaseOrderService, grnSvc: GRNService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Procurement", "/procurement", ctx);

  // Suppliers
  r.post("/suppliers").summary("Register supplier").permission("procurement:admin")
    .input(z.object({ name: z.string().min(1), code: z.string().min(1), contactName: z.string().optional(), contactEmail: z.string().email().optional(), contactPhone: z.string().optional(), paymentTermsDays: z.number().int().optional(), currency: z.string().optional() }))
    .handler(async ({ input, orgId }) => {
      const result = await supplierSvc.create(orgId, input as Parameters<typeof supplierSvc.create>[1]);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/suppliers").summary("List suppliers").permission("procurement:read")
    .handler(async ({ orgId }) => {
      const result = await supplierSvc.list(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/suppliers/{id}").summary("Get supplier with items").permission("procurement:read")
    .handler(async ({ params, orgId }) => {
      const result = await supplierSvc.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/suppliers/{id}/items").summary("Link item to supplier").permission("procurement:admin")
    .input(z.object({ entityId: z.string().uuid(), variantId: z.string().uuid().optional(), supplierSku: z.string().optional(), unitCost: z.number().int().positive(), minOrderQuantity: z.number().int().optional(), leadTimeDays: z.number().int().optional(), isPreferred: z.boolean().optional() }))
    .handler(async ({ params, input }) => {
      const result = await supplierSvc.addItem(params.id!, input as Parameters<typeof supplierSvc.addItem>[1]);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // Purchase Orders
  r.post("/purchase-orders").summary("Create purchase order").permission("procurement:create")
    .input(z.object({
      supplierId: z.string().uuid(), warehouseId: z.string().uuid(), notes: z.string().optional(),
      expectedDelivery: z.string().optional(),
      items: z.array(z.object({ entityId: z.string().uuid(), variantId: z.string().uuid().optional(), itemName: z.string(), quantityOrdered: z.number().int().positive(), unitCost: z.number().int().positive() })).min(1),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as Parameters<typeof poSvc.create>[1];
      const result = await poSvc.create(orgId, { ...body, requestedBy: actor!.userId });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/purchase-orders").summary("List purchase orders").permission("procurement:read")
    .query(z.object({ status: z.string().optional() }))
    .handler(async ({ query, orgId }) => {
      const result = await poSvc.list(orgId, (query as { status?: string }).status);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/purchase-orders/{id}").summary("Get PO with items").permission("procurement:read")
    .handler(async ({ params, orgId }) => {
      const result = await poSvc.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/purchase-orders/{id}/submit").summary("Submit PO for approval").permission("procurement:create")
    .handler(async ({ params, orgId }) => {
      const result = await poSvc.submit(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/purchase-orders/{id}/approve").summary("Approve PO").permission("procurement:admin")
    .handler(async ({ params, actor, orgId }) => {
      const result = await poSvc.approve(orgId, params.id!, actor!.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/purchase-orders/{id}/cancel").summary("Cancel PO").permission("procurement:admin")
    .handler(async ({ params, orgId }) => {
      const result = await poSvc.cancel(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // GRN
  r.post("/grn").summary("Create GRN").permission("procurement:create")
    .input(z.object({
      poId: z.string().uuid(), supplierId: z.string().uuid(), warehouseId: z.string().uuid(), notes: z.string().optional(),
      items: z.array(z.object({
        poItemId: z.string().uuid(), entityId: z.string().uuid(), variantId: z.string().uuid().optional(),
        quantityOrdered: z.number().int(), quantityReceived: z.number().int(), quantityAccepted: z.number().int(),
        quantityRejected: z.number().int().optional(), rejectionReason: z.string().optional(),
        batchNumber: z.string().optional(), expiryDate: z.string().optional(), unitCost: z.number().int(),
      })).min(1),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as Parameters<typeof grnSvc.create>[1];
      const result = await grnSvc.create(orgId, { ...body, receivedBy: actor!.userId });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/grn").summary("List GRNs").permission("procurement:read")
    .handler(async ({ orgId }) => {
      const result = await grnSvc.list(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/grn/{id}").summary("Get GRN with items").permission("procurement:read")
    .handler(async ({ params, orgId }) => {
      const result = await grnSvc.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/grn/{id}/accept").summary("Accept GRN").permission("procurement:admin")
    .handler(async ({ params, orgId }) => {
      const result = await grnSvc.accept(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
