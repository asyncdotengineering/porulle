import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ShiftService } from "../services/shift-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildShiftRoutes(
  service: ShiftService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Shifts", "/pos/shifts", ctx);

  r.post("/open")
    .summary("Open shift")
    .permission("pos:operate")
    .input(z.object({
      terminalId: z.string().uuid(),
      openingFloat: z.number().int().min(0),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as { terminalId: string; openingFloat: number };
      const result = await service.open(orgId, {
        ...body,
        operatorId: actor!.userId,
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/close")
    .summary("Close shift")
    .permission("pos:operate")
    .input(z.object({
      closingCount: z.number().int().min(0),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { closingCount: number };
      const result = await service.close(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/current")
    .summary("Get current open shift")
    .permission("pos:operate")
    .handler(async ({ actor, orgId }) => {
      const result = await service.getCurrent(orgId, actor!.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}")
    .summary("Get shift details")
    .permission("pos:operate")
    .handler(async ({ params, orgId }) => {
      const result = await service.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}/report")
    .summary("Z-report")
    .permission("pos:admin")
    .handler(async ({ params, orgId }) => {
      const result = await service.getReport(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // ─── Cash Events ───────────────────────────────────────────────────

  r.post("/{id}/cash-events")
    .summary("Record cash event")
    .permission("pos:operate")
    .input(z.object({
      type: z.enum(["drop", "pickup", "paid_in", "paid_out"]),
      amount: z.number().int().positive(),
      reason: z.string().max(500).optional(),
    }))
    .handler(async ({ params, input, actor }) => {
      const body = input as { type: "drop" | "pickup" | "paid_in" | "paid_out"; amount: number; reason?: string };
      const result = await service.addCashEvent(params.id!, {
        ...body,
        performedBy: actor!.userId,
      });

      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}/cash-events")
    .summary("List cash events")
    .permission("pos:operate")
    .handler(async ({ params }) => {
      const result = await service.listCashEvents(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
