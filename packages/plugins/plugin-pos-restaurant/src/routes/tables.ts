import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { TableService } from "../services/table-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildTableRoutes(
  service: TableService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant Tables", "/pos/restaurant/tables", ctx);

  r.post("/")
    .summary("Create table")
    .permission("pos-restaurant:admin")
    .input(z.object({
      number: z.string().min(1).max(50),
      zone: z.string().min(1).max(100),
      capacity: z.number().int().min(1).max(100).optional(),
      minimumSeats: z.number().int().min(1).optional(),
      shape: z.enum(["rectangle", "square", "circle"]).optional(),
      isTakeaway: z.boolean().optional(),
      layoutX: z.number().int().optional(),
      layoutY: z.number().int().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { number: string; zone: string; capacity?: number; minimumSeats?: number; shape?: "rectangle" | "square" | "circle"; isTakeaway?: boolean; layoutX?: number; layoutY?: number };
      const result = await service.create(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/zones")
    .summary("List zones with table counts")
    .permission("pos:operate")
    .handler(async ({ orgId }) => {
      const result = await service.listZones(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/")
    .summary("List tables")
    .permission("pos:operate")
    .query(z.object({ zone: z.string().optional() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { zone?: string };
      const result = await service.list(orgId, q.zone);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.patch("/{id}")
    .summary("Update table")
    .permission("pos-restaurant:admin")
    .input(z.object({
      number: z.string().min(1).max(50).optional(),
      zone: z.string().min(1).max(100).optional(),
      capacity: z.number().int().min(1).optional(),
      shape: z.enum(["rectangle", "square", "circle"]).optional(),
      assignedOperatorId: z.string().nullable().optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { number?: string; zone?: string; capacity?: number; shape?: "rectangle" | "square" | "circle"; assignedOperatorId?: string | null };
      const result = await service.update(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/assign")
    .summary("Assign table to transaction")
    .permission("pos:operate")
    .input(z.object({ transactionId: z.string().uuid() }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { transactionId: string };
      const result = await service.assignToTransaction(orgId, params.id!, body.transactionId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/clear")
    .summary("Clear table")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.clear(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/transfer")
    .summary("Transfer to another table")
    .permission("pos:operate")
    .input(z.object({ toTableId: z.string().uuid() }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { toTableId: string };
      const result = await service.transfer(orgId, params.id!, body.toTableId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.patch("/{id}/layout")
    .summary("Update floor plan layout")
    .permission("pos-restaurant:admin")
    .input(z.object({
      layoutX: z.number().int().optional(),
      layoutY: z.number().int().optional(),
      layoutWidth: z.number().int().optional(),
      layoutHeight: z.number().int().optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { layoutX?: number; layoutY?: number; layoutWidth?: number; layoutHeight?: number };
      const result = await service.updateLayout(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
