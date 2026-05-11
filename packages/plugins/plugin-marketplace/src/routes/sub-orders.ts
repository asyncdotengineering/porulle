import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { z } from "@hono/zod-openapi";
import type { SubOrderService } from "../services/sub-order.js";
import type { SubOrderStatus } from "../types.js";
import { UpdateSubOrderStatusBodySchema } from "../schemas/sub-orders.js";
import { stripUndefined } from "./util.js";

export function buildSubOrderRoutes(services: {
  subOrder: SubOrderService;
}): PluginRouteRegistration[] {
  const r = router("Marketplace - Sub-Orders", "/marketplace/sub-orders");

  // ─── List sub-orders ───────────────────────────────────────────────────────
  r.get("/")
    .summary("List sub-orders")
    .permission("marketplace:admin")
    .handler(async ({ query }) => {
      return services.subOrder.list(stripUndefined({
        orderId: query.orderId as string | undefined,
        vendorId: query.vendorId as string | undefined,
        status: query.status as string | undefined,
      }));
    });

  // ─── Get sub-order by id ───────────────────────────────────────────────────
  r.get("/{id}")
    .summary("Get sub-order by ID")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const subOrder = await services.subOrder.getById(params.id!);
      if (!subOrder) throw new Error("Sub-order not found");
      return subOrder;
    });

  // ─── Force status change ───────────────────────────────────────────────────
  r.patch("/{id}/status")
    .summary("Force a sub-order status change")
    .permission("marketplace:admin")
    .input(UpdateSubOrderStatusBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof UpdateSubOrderStatusBodySchema>;
      const subOrder = await services.subOrder.getById(params.id!);
      if (!subOrder) throw new Error("Sub-order not found");

      // Use cancel() for cancelled status to trigger side effects
      // (inventory release + ledger reversal)
      return body.status === "cancelled"
        ? services.subOrder.cancel(params.id!, "Admin force cancel")
        : services.subOrder.forceStatus(params.id!, body.status as SubOrderStatus);
    });

  return r.routes();
}
