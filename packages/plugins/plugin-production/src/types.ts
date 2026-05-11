export type { PluginDb as Db } from "@porulle/core";
import type { productionBoms, productionBomItems, productionOrders, productionConsumption } from "./schema.js";
export type BOM = typeof productionBoms.$inferSelect;
export type BOMItem = typeof productionBomItems.$inferSelect;
export type ProductionOrder = typeof productionOrders.$inferSelect;
export type Consumption = typeof productionConsumption.$inferSelect;
