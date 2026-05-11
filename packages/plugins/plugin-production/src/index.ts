import { defineCommercePlugin } from "@porulle/core";
import { productionBoms, productionBomItems, productionOrders, productionConsumption } from "./schema.js";
import { ProductionService } from "./services/production-service.js";
import { ProductionOrderService } from "./services/production-order-service.js";
import { buildProductionRoutes } from "./routes/production.js";
import type { Db } from "./types.js";

export type { Db } from "./types.js";
export { ProductionService } from "./services/production-service.js";
export { ProductionOrderService } from "./services/production-order-service.js";

export function productionPlugin() {
  return defineCommercePlugin({
    id: "production",
    version: "1.0.0",
    permissions: [
      { scope: "production:admin", description: "Create/edit BOMs, cost rollup, cancel orders." },
      { scope: "production:create", description: "Create and manage production orders." },
      { scope: "production:read", description: "View BOMs, orders, and BOM explosion." },
    ],
    schema: () => ({ productionBoms, productionBomItems, productionOrders, productionConsumption }),
    hooks: () => [],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      return buildProductionRoutes(
        new ProductionService(db),
        new ProductionOrderService(db),
        ctx,
      );
    },
  });
}
