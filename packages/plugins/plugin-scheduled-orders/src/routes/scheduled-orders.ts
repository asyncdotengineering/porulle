import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ScheduledOrderService } from "../services/scheduled-order-service.js";
import type { PluginRouteRegistration } from "@porulle/core";
import type { ScheduledOrderStatus } from "../types.js";

export function buildScheduledOrderRoutes(
  service: ScheduledOrderService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Scheduled Orders", "/scheduled-orders", ctx);

  r.post("/").summary("Create scheduled order").permission("scheduled-orders:create")
    .input(z.object({
      customerId: z.string().uuid(),
      cartId: z.string().uuid(),
      scheduledFor: z.string().datetime(),
      orderType: z.enum(["pickup", "delivery", "dine_in"]).optional(),
      pickupLocation: z.string().optional(),
      deliveryAddress: z.any().optional(),
      notes: z.string().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const body = input as {
        customerId: string; cartId: string; scheduledFor: string;
        orderType?: "pickup" | "delivery" | "dine_in";
        pickupLocation?: string; deliveryAddress?: unknown; notes?: string;
      };
      const result = await service.create(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/").summary("List scheduled orders").permission("scheduled-orders:read")
    .query(z.object({ status: z.enum(["scheduled", "processing", "completed", "cancelled", "expired"]).optional() }))
    .handler(async ({ query, orgId }) => {
      const q = query as { status?: ScheduledOrderStatus };
      const result = await service.list(orgId, q.status);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/{id}").summary("Get scheduled order by ID").permission("scheduled-orders:read")
    .handler(async ({ params, orgId }) => {
      const result = await service.getById(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/cancel").summary("Cancel scheduled order").permission("scheduled-orders:create")
    .handler(async ({ params, orgId }) => {
      const result = await service.cancel(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/process-due").summary("Process due scheduled orders").permission("scheduled-orders:admin")
    .input(z.object({ bufferMinutes: z.number().int().min(0).optional() }))
    .handler(async ({ input, orgId }) => {
      const body = input as { bufferMinutes?: number };
      const result = await service.processDue(orgId, body.bufferMinutes);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
