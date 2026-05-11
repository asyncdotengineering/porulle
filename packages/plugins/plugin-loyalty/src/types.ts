import type { loyaltyPoints, loyaltyTransactions, loyaltyRedemptionOffers } from "./schema.js";

export type { PluginDb as Db } from "@porulle/core";
export type LoyaltyPoints = typeof loyaltyPoints.$inferSelect;
export type LoyaltyTransaction = typeof loyaltyTransactions.$inferSelect;
export type LoyaltyOffer = typeof loyaltyRedemptionOffers.$inferSelect;
export type Tier = "bronze" | "silver" | "gold" | "platinum";

export interface LoyaltyPluginOptions {
  pointsPerDollar?: number;
  tierThresholds?: { silver: number; gold: number; platinum: number };
}

export const DEFAULT_LOYALTY_OPTIONS: Required<LoyaltyPluginOptions> = {
  pointsPerDollar: 1,
  tierThresholds: { silver: 500, gold: 1500, platinum: 3000 },
};
