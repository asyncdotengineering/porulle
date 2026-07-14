export type { PluginDb as Db } from "@porulle/core";
import type {
  posTerminals,
  posShifts,
  posCashEvents,
  posTransactions,
  posPayments,
  posReturnItems,
  posOperatorPins,
  posPinAttempts,
} from "./schema.js";

export type Terminal = typeof posTerminals.$inferSelect;
export type TerminalInsert = typeof posTerminals.$inferInsert;

export type Shift = typeof posShifts.$inferSelect;
export type ShiftInsert = typeof posShifts.$inferInsert;

export type CashEvent = typeof posCashEvents.$inferSelect;
export type CashEventInsert = typeof posCashEvents.$inferInsert;

export type Transaction = typeof posTransactions.$inferSelect;
export type TransactionInsert = typeof posTransactions.$inferInsert;

export type Payment = typeof posPayments.$inferSelect;
export type PaymentInsert = typeof posPayments.$inferInsert;

export type ReturnItem = typeof posReturnItems.$inferSelect;
export type ReturnItemInsert = typeof posReturnItems.$inferInsert;

export type OperatorPin = typeof posOperatorPins.$inferSelect;
export type OperatorPinInsert = typeof posOperatorPins.$inferInsert;

export type PinAttempt = typeof posPinAttempts.$inferSelect;
export type PinAttemptInsert = typeof posPinAttempts.$inferInsert;

export type TransactionStatus = "open" | "held" | "completed" | "voided";
export type TransactionType = "sale" | "return" | "exchange";
export type PaymentMethod = "cash" | "card" | "gift_card" | "store_credit" | "other";
export type CashEventType = "float" | "drop" | "pickup" | "paid_in" | "paid_out";
export type ShiftStatus = "open" | "closed";
export type TerminalType = "register" | "tablet" | "mobile" | "kiosk";

export interface POSPluginOptions {
  /** Default currency for new transactions. Default: "USD" */
  defaultCurrency?: string;
  /** Maximum hold duration in hours before auto-void. Default: 24 */
  maxHoldHours?: number;
  /** Require manager override for discounts above this percentage. Default: 20 */
  discountOverrideThreshold?: number;
  /** PIN auth runtime (issue #51). */
  pinAuth?: {
    /** Named auth.apiKeyScopes config used to mint per-shift keys. */
    apiKeyScope?: string;
    /** Shift-credential lifetime in seconds. Default: 43200 (12h). */
    credentialTtlSeconds?: number;
    /** Failed PIN attempts before lockout. Default: 5 (SEC-15). */
    lockoutMaxAttempts?: number;
    /** Failure counting window and lockout duration in minutes. Default: 15 (SEC-15). */
    lockoutWindowMinutes?: number;
  };
}

export const DEFAULT_POS_OPTIONS: Required<POSPluginOptions> = {
  defaultCurrency: "USD",
  maxHoldHours: 24,
  discountOverrideThreshold: 20,
  pinAuth: {},
};
