import type { scheduledOrders } from "./schema.js";

export type { PluginDb as Db } from "@porulle/core";
export type ScheduledOrder = typeof scheduledOrders.$inferSelect;
export type ScheduledOrderStatus = "scheduled" | "processing" | "completed" | "cancelled" | "expired";
export type ScheduledOrderType = "pickup" | "delivery" | "dine_in";
