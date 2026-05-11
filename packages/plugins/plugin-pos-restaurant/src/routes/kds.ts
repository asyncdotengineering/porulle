import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { KDSService } from "../services/kds-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildKDSRoutes(
  service: KDSService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Restaurant KDS", "/pos/restaurant/kds", ctx);

  // ─── Stations ──────────────────────────────────────────────────────

  r.post("/stations")
    .summary("Create KDS station")
    .permission("pos-restaurant:admin")
    .input(z.object({
      name: z.string().min(1).max(100),
      alertThresholdMinutes: z.number().int().min(1).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as { name: string; alertThresholdMinutes?: number; metadata?: Record<string, unknown> };
      const result = await service.createStation(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/stations")
    .summary("List KDS stations")
    .permission("pos:operate")
    .handler(async ({ orgId }) => {
      const result = await service.listStations(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.patch("/stations/{id}")
    .summary("Update KDS station")
    .permission("pos-restaurant:admin")
    .input(z.object({
      name: z.string().min(1).max(100).optional(),
      isActive: z.boolean().optional(),
      alertThresholdMinutes: z.number().int().min(1).optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { name?: string; isActive?: boolean; alertThresholdMinutes?: number };
      const result = await service.updateStation(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/stations/{id}/item-groups")
    .summary("Add item group to station")
    .permission("pos-restaurant:admin")
    .input(z.object({ itemGroup: z.string().min(1) }))
    .handler(async ({ params, input }) => {
      const body = input as { itemGroup: string };
      const result = await service.addItemGroup(params.id!, body.itemGroup);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.delete("/stations/{id}/item-groups/{group}")
    .summary("Remove item group from station")
    .permission("pos-restaurant:admin")
    .handler(async ({ params }) => {
      const result = await service.removeItemGroup(params.id!, params.group!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // ─── Tickets ───────────────────────────────────────────────────────

  r.get("/stations/{id}/tickets")
    .summary("List pending tickets for station")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.listPendingTickets(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/tickets/{id}/start")
    .summary("Mark ticket as preparing")
    .permission("pos:operate")
    .handler(async ({ params }) => {
      const result = await service.startTicket(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/tickets/{id}/ready")
    .summary("Mark ticket as ready")
    .permission("pos:operate")
    .handler(async ({ params }) => {
      const result = await service.readyTicket(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/tickets/{id}/serve")
    .summary("Mark ticket as served")
    .permission("pos:operate")
    .handler(async ({ params }) => {
      const result = await service.serveTicket(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/tickets/{id}/items/{itemId}/done")
    .summary("Mark ticket item as done")
    .permission("pos:operate")
    .handler(async ({ params }) => {
      const result = await service.markItemDone(params.id!, params.itemId!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
