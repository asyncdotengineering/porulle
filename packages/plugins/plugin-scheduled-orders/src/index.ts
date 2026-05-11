import { defineCommercePlugin } from "@porulle/core";
import { scheduledOrders } from "./schema.js";
import { ScheduledOrderService } from "./services/scheduled-order-service.js";
import { buildScheduledOrderRoutes } from "./routes/scheduled-orders.js";
import type { Db } from "./types.js";

export type { Db } from "./types.js";
export { ScheduledOrderService } from "./services/scheduled-order-service.js";

export function scheduledOrdersPlugin() {
  return defineCommercePlugin({
    id: "scheduled-orders",
    version: "1.0.0",
    permissions: [
      { scope: "scheduled-orders:admin", description: "Process due scheduled orders and admin operations." },
      { scope: "scheduled-orders:create", description: "Create and cancel scheduled orders." },
      { scope: "scheduled-orders:read", description: "View scheduled orders." },
    ],
    schema: () => ({ scheduledOrders }),
    hooks: () => [],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      return buildScheduledOrderRoutes(new ScheduledOrderService(db), ctx);
    },
  });
}
