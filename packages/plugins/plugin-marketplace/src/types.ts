// ─── Sub-Order Status ────────────────────────────────────────────────────────

export type SubOrderStatus =
  | "pending"
  | "confirmed"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";

export const SUB_ORDER_TRANSITIONS: Record<SubOrderStatus, SubOrderStatus[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

// ─── Vendor ──────────────────────────────────────────────────────────────────

export type VendorStatus = "pending" | "approved" | "suspended";
export type VerificationStatus = "unverified" | "documents_submitted" | "verified" | "rejected";
export type VendorTier = "standard" | "silver" | "gold" | "platinum";
export type PayoutSchedule = "daily" | "weekly" | "biweekly" | "monthly" | "manual";
export type VendorApprovalMode = "manual" | "auto" | "invitation";

// ─── Commission ──────────────────────────────────────────────────────────────

export type CommissionRuleType = "category" | "volume_tier" | "vendor_tier" | "promotional";

// ─── Disputes ────────────────────────────────────────────────────────────────

export type DisputeStatus =
  | "open"
  | "vendor_response_pending"
  | "platform_review"
  | "resolved"
  | "escalated"
  | "closed";

export type DisputeReason =
  | "item_not_received"
  | "item_not_as_described"
  | "defective"
  | "wrong_item"
  | "other";

export type DisputeResolution =
  | "refund_full"
  | "refund_partial"
  | "replacement"
  | "rejected"
  | "vendor_favor"
  | "buyer_favor";

// ─── Returns ─────────────────────────────────────────────────────────────────

export type ReturnStatus =
  | "requested"
  | "vendor_approved"
  | "vendor_rejected"
  | "shipped_back"
  | "received"
  | "refunded"
  | "closed";

export type ReturnReason =
  | "defective"
  | "wrong_item"
  | "not_as_described"
  | "changed_mind"
  | "other";

// ─── Balance Ledger ──────────────────────────────────────────────────────────

export type BalanceEntryType =
  | "sale"
  | "commission"
  | "refund_deduction"
  | "adjustment"
  | "payout";

// ─── Document ────────────────────────────────────────────────────────────────

export type DocumentType = "business_license" | "tax_form" | "bank_proof" | "identity" | "other";
export type DocumentStatus = "pending" | "approved" | "rejected";

// ─── Review ──────────────────────────────────────────────────────────────────

export type ReviewStatus = "pending" | "published" | "hidden" | "flagged";

// ─── RFQ ─────────────────────────────────────────────────────────────────────

export type RFQStatus = "open" | "closed" | "awarded" | "cancelled";
export type RFQResponseStatus = "submitted" | "shortlisted" | "accepted" | "rejected" | "withdrawn";

// ─── Plugin Options ──────────────────────────────────────────────────────────

export interface MarketplacePluginOptions {
  defaultCommissionRateBps?: number;

  vendorApprovalMode?: VendorApprovalMode;
  requiredDocuments?: DocumentType[];

  defaultPayoutSchedule?: PayoutSchedule;
  defaultPayoutMinimumCents?: number;
  defaultHoldbackDays?: number;

  vendorResponseDeadlineDays?: number;
  autoEscalateOnMissedDeadline?: boolean;

  returnWindowDays?: number;
  autoApproveReturnsOnVendorTimeout?: boolean;
  vendorReturnResponseDays?: number;

  requireVerifiedPurchase?: boolean;
  reviewModerationEnabled?: boolean;

  b2b?: {
    rfq?: boolean;
    contractPricing?: boolean;
  };

  performanceThresholds?: {
    minRating?: number;
    maxDefectRatePercent?: number;
    maxLateShipmentRatePercent?: number;
    maxCancellationRatePercent?: number;
  };
}

// ─── Db type ─────────────────────────────────────────────────────────────────

/**
 * Driver-agnostic Drizzle PostgreSQL database type.
 *
 * `PgDatabase` from `drizzle-orm/pg-core` is the base class that all PG drivers
 * extend (postgres-js, pglite, node-postgres). Using it with
 * `Record<string, unknown>` as the schema generic means:
 * - Row types are fully inferred from `pgTable` schema objects (`.from(vendors)`)
 * - No coupling to any specific driver package
 * - Works identically with PGlite in tests and postgres-js in production
 */
export type { PluginDb as Db } from "@porulle/core";

// ─── Route Context ───────────────────────────────────────────────────────────

/** Minimal Hono-compatible context for route handlers */
export interface RouteContext {
  req: {
    json(): Promise<Record<string, unknown>>;
    param(name: string): string;
    query(name: string): string | undefined;
  };
  json(data: unknown, status?: number): Response;
  get(key: string): unknown;
}

// ─── Error helper ────────────────────────────────────────────────────────────

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Internal server error";
}
