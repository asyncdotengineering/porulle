export type { PluginDb as Db } from "@porulle/core";
import type {
  posModifierGroups,
  posModifierOptions,
  posTables,
  posTableAssignments,
  kdsStations,
  kdsStationItemGroups,
  kdsTickets,
  kdsTicketItems,
} from "./schema.js";

// ─── Modifier Types ─────────────────────────────────────────────────────

export type ModifierGroup = typeof posModifierGroups.$inferSelect;
export type ModifierGroupInsert = typeof posModifierGroups.$inferInsert;
export type ModifierOption = typeof posModifierOptions.$inferSelect;
export type ModifierOptionInsert = typeof posModifierOptions.$inferInsert;

// ─── Table Types ────────────────────────────────────────────────────────

export type Table = typeof posTables.$inferSelect;
export type TableInsert = typeof posTables.$inferInsert;
export type TableAssignment = typeof posTableAssignments.$inferSelect;
export type TableAssignmentInsert = typeof posTableAssignments.$inferInsert;

export type TableStatus = "available" | "occupied" | "bill_requested" | "cleaning";
export type TableShape = "rectangle" | "square" | "circle";

// ─── KDS Types ──────────────────────────────────────────────────────────

export type KDSStation = typeof kdsStations.$inferSelect;
export type KDSStationInsert = typeof kdsStations.$inferInsert;
export type KDSStationItemGroup = typeof kdsStationItemGroups.$inferSelect;
export type KDSTicket = typeof kdsTickets.$inferSelect;
export type KDSTicketInsert = typeof kdsTickets.$inferInsert;
export type KDSTicketItem = typeof kdsTicketItems.$inferSelect;
export type KDSTicketItemInsert = typeof kdsTicketItems.$inferInsert;

export type TicketType = "new_order" | "modified" | "cancelled" | "partially_cancelled";
export type TicketStatus = "pending" | "preparing" | "ready" | "served";
export type TicketItemStatus = "pending" | "preparing" | "done";
export type OrderType = "dine_in" | "takeaway" | "delivery";

// ─── Plugin Options ─────────────────────────────────────────────────────

export interface POSRestaurantPluginOptions {
  /** Enable kitchen display system. Default: true */
  enableKDS?: boolean;
  /** Enable tip collection on payments. Default: true */
  enableTips?: boolean;
  /** Enable item modifiers. Default: true */
  enableModifiers?: boolean;
  /** Minutes before KDS ticket turns red. Default: 15 */
  kdsAlertMinutes?: number;
}

export const DEFAULT_RESTAURANT_OPTIONS: Required<POSRestaurantPluginOptions> = {
  enableKDS: true,
  enableTips: true,
  enableModifiers: true,
  kdsAlertMinutes: 15,
};
