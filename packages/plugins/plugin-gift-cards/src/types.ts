export type { PluginDb as Db } from "@porulle/core";
import type { giftCards, giftCardTransactions } from "./schema.js";

export type GiftCard = typeof giftCards.$inferSelect;
export type GiftCardInsert = typeof giftCards.$inferInsert;
export type GiftCardTransaction = typeof giftCardTransactions.$inferSelect;
export type GiftCardTransactionInsert = typeof giftCardTransactions.$inferInsert;

export type GiftCardStatus = "active" | "disabled" | "exhausted";
export type TransactionType = "debit" | "credit" | "refund";

export interface GiftCardPluginOptions {
  /** Code format pattern. Default: "XXXX-XXXX-XXXX-XXXX" */
  codeFormat?: string;
  /** Default expiry duration in days. null = no expiry. Default: null */
  defaultExpiryDays?: number | null;
  /** Maximum balance per card in minor units. Default: 10_000_00 (100,000.00) */
  maxBalancePerCard?: number;
  /** Email template name for gift card delivery. Default: "gift-card-delivery" */
  emailTemplate?: string;
  /** Allow partial redemption. Default: true */
  allowPartialRedemption?: boolean;
  /** Entity type that triggers gift card issuance on purchase. Default: "gift_card" */
  productType?: string;
}

export const DEFAULT_OPTIONS: Required<GiftCardPluginOptions> = {
  codeFormat: "XXXX-XXXX-XXXX-XXXX",
  defaultExpiryDays: 0 as number,
  maxBalancePerCard: 10_000_00,
  emailTemplate: "gift-card-delivery",
  allowPartialRedemption: true,
  productType: "gift_card",
};

export interface GiftCardDeduction {
  code: string;
  giftCardId: string;
  amount: number;
  balanceAfter: number;
}
