import type { sellableEntities } from "../modules/catalog/schema.js";
import type { orders } from "../modules/orders/schema.js";
import type { carts } from "../modules/cart/schema.js";
import type { customers } from "../modules/customers/schema.js";
import type { inventoryLevels } from "../modules/inventory/schema.js";

/**
 * Central type map for all commerce entities.
 *
 * Plugins can augment this interface via TypeScript module augmentation:
 *
 * ```typescript
 * declare module "@porulle/core" {
 *   interface CommerceModuleTypes {
 *     LoyaltyPoints: {
 *       id: string;
 *       customerId: string;
 *       points: number;
 *       tier: "bronze" | "silver" | "gold";
 *     };
 *   }
 * }
 * ```
 *
 * This enables plugin types to be referenced without importing
 * internal schema modules.
 */
export interface CommerceModuleTypes {
  Product: typeof sellableEntities.$inferSelect;
  Order: typeof orders.$inferSelect;
  Cart: typeof carts.$inferSelect;
  Customer: typeof customers.$inferSelect;
  InventoryLevel: typeof inventoryLevels.$inferSelect;
}
