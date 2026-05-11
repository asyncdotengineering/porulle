import type { AnalyticsModel } from "@porulle/core";

/**
 * Marketplace analytics models — SQL-based definitions for vendor-scoped analytics.
 *
 * These models describe the marketplace tables (marketplace_vendor_sub_orders,
 * marketplace_vendor_balances, marketplace_vendor_reviews) and are registered
 * on the DrizzleAnalyticsAdapter via the plugin's analyticsModels manifest slot.
 */

export const VENDOR_ORDERS_MODEL: AnalyticsModel = {
  name: "VendorOrders",
  table: "marketplace_vendor_sub_orders",
  scopeRules: [
    { role: "vendor", filter: "vendor_id = :vendorId" },
  ],
  measures: {
    count:          { type: "count" },
    revenue:        { sql: "subtotal", type: "sum" },
    commissionPaid: { sql: "commission_amount", type: "sum" },
    netPayout:      { sql: "payout_amount", type: "sum" },
  },
  dimensions: {
    id:        { sql: "id", type: "string" },
    vendorId:  { sql: "vendor_id", type: "string" },
    orderId:   { sql: "order_id", type: "string" },
    status:    { sql: "status", type: "string" },
    createdAt: { sql: "created_at", type: "time" },
  },
};

export const VENDOR_BALANCE_MODEL: AnalyticsModel = {
  name: "VendorBalance",
  table: "marketplace_vendor_balances",
  scopeRules: [
    { role: "vendor", filter: "vendor_id = :vendorId" },
  ],
  measures: {
    totalCredits:  { sql: "CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END", type: "sum" },
    totalDebits:   { sql: "CASE WHEN amount_cents < 0 THEN ABS(amount_cents) ELSE 0 END", type: "sum" },
    netBalance:    { sql: "amount_cents", type: "sum" },
    entryCount:    { type: "count" },
  },
  dimensions: {
    id:        { sql: "id", type: "string" },
    vendorId:  { sql: "vendor_id", type: "string" },
    type:      { sql: "type", type: "string" },
    createdAt: { sql: "created_at", type: "time" },
  },
};

export const VENDOR_REVIEWS_MODEL: AnalyticsModel = {
  name: "VendorReviews",
  table: "marketplace_vendor_reviews",
  scopeRules: [
    { role: "vendor", filter: "vendor_id = :vendorId" },
  ],
  measures: {
    count:         { type: "count" },
    averageRating: { sql: "rating", type: "avg" },
  },
  dimensions: {
    id:        { sql: "id", type: "string" },
    vendorId:  { sql: "vendor_id", type: "string" },
    rating:    { sql: "rating", type: "number" },
    status:    { sql: "status", type: "string" },
    createdAt: { sql: "created_at", type: "time" },
  },
};

export const MARKETPLACE_ANALYTICS_MODELS: AnalyticsModel[] = [
  VENDOR_ORDERS_MODEL,
  VENDOR_BALANCE_MODEL,
  VENDOR_REVIEWS_MODEL,
];
