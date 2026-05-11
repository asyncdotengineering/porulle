import { boolean, integer, jsonb, pgTable, text, timestamp, uuid, index, uniqueIndex } from "@porulle/core/drizzle";

// ─── Vendors ─────────────────────────────────────────────────────────────────

export const vendors = pgTable("marketplace_vendors", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug"),
  email: text("email"),
  description: text("description"),
  logoUrl: text("logo_url"),
  bannerUrl: text("banner_url"),
  contactPhone: text("contact_phone"),
  businessAddress: jsonb("business_address").$type<{
    line1?: string; line2?: string; city?: string; state?: string;
    postalCode?: string; country?: string;
  }>(),
  bankAccount: jsonb("bank_account").$type<{
    accountHolder?: string; bankName?: string; routingNumber?: string;
    accountNumber?: string; iban?: string; swift?: string;
  }>(),
  taxId: text("tax_id"),
  status: text("status").notNull().default("pending"),
  verificationStatus: text("verification_status").notNull().default("unverified"),
  rejectionReason: text("rejection_reason"),
  approvedCategories: jsonb("approved_categories").$type<string[] | null>(),
  tier: text("tier").notNull().default("standard"),
  performanceScore: integer("performance_score").notNull().default(100),
  suspensionReason: text("suspension_reason"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  commissionRateBps: integer("commission_rate_bps").notNull().default(1000),
  payoutSchedule: text("payout_schedule").notNull().default("weekly"),
  payoutMinimumCents: integer("payout_minimum_cents").notNull().default(5000),
  holdbackDays: integer("holdback_days").notNull().default(7),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),

  // ─── Store Connection (links vendor to their Shopify/WooCommerce store) ─────
  storeConnectionProvider: text("store_connection_provider"),  // "shopify" | "woocommerce" | null
  storeConnectionUrl: text("store_connection_url"),
  storeAccessToken: text("store_access_token"),               // Shopify token or WC consumer key
  storeConsumerSecret: text("store_consumer_secret"),          // WooCommerce consumer secret (null for Shopify)
  storeWebhookSecret: text("store_webhook_secret"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  syncStatus: text("sync_status").default("disconnected"),    // "healthy" | "stale" | "error" | "disconnected"

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgSlugUnique: uniqueIndex("marketplace_vendors_org_slug_unique").on(table.organizationId, table.slug),
  orgIdx: index("idx_marketplace_vendors_org").on(table.organizationId),
}));

// ─── Vendor–Entity Links ─────────────────────────────────────────────────────

export const vendorEntities = pgTable("marketplace_vendor_entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  entityId: uuid("entity_id").notNull(), // FK: → sellable_entities.id (cross-package; skipped due to drizzle-orm version mismatch between core and plugin)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Vendor Documents ────────────────────────────────────────────────────────

export const vendorDocuments = pgTable("marketplace_vendor_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  fileUrl: text("file_url").notNull(),
  status: text("status").notNull().default("pending"),
  reviewerNotes: text("reviewer_notes"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

// ─── Commission Rules ────────────────────────────────────────────────────────

export const commissionRules = pgTable("marketplace_commission_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  categorySlug: text("category_slug"),
  vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "cascade" }),
  vendorTier: text("vendor_tier"),
  minVolumeCents: integer("min_volume_cents"),
  maxVolumeCents: integer("max_volume_cents"),
  rateBps: integer("rate_bps").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

// ─── Sub-Orders ──────────────────────────────────────────────────────────────

export const vendorSubOrders = pgTable("marketplace_vendor_sub_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull(), // FK: → orders.id (cross-package; skipped due to drizzle-orm version mismatch between core and plugin)
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  subtotal: integer("subtotal").notNull().default(0),
  commissionAmount: integer("commission_amount").notNull().default(0),
  payoutAmount: integer("payout_amount").notNull().default(0),
  notified: boolean("notified").notNull().default(false),
  lineItems: jsonb("line_items").$type<Array<{ entityId: string; quantity: number; totalPrice: number }>>().default([]),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  carrier: text("carrier"),
  fulfillmentStatus: text("fulfillment_status").notNull().default("unfulfilled"),  // "unfulfilled" | "partially_fulfilled" | "fulfilled"
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancellationReason: text("cancellation_reason"),
  vendorNotes: text("vendor_notes"),

  // ─── External Store Sync ────────────────────────────────────────────────────
  externalOrderId: text("external_order_id"),       // Order ID in vendor's external store
  externalOrderUrl: text("external_order_url"),      // Admin URL for vendor to view the order
  externalSyncStatus: text("external_sync_status").default("pending"),  // "pending" | "synced" | "failed"

  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Payouts ─────────────────────────────────────────────────────────────────

export const vendorPayouts = pgTable("marketplace_vendor_payouts", {
  id: uuid("id").defaultRandom().primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  subOrderId: uuid("sub_order_id"),
  amount: integer("amount").notNull().default(0),
  status: text("status").notNull().default("pending"),
  payoutMethod: text("payout_method"),
  externalReference: text("external_reference"),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  grossAmount: integer("gross_amount"),
  deductions: jsonb("deductions").$type<Array<{ type: string; amount: number; reference?: string }>>(),
  netAmount: integer("net_amount"),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  retryCount: integer("retry_count").notNull().default(0),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Vendor Balance Ledger ───────────────────────────────────────────────────

export const vendorBalances = pgTable("marketplace_vendor_balances", {
  id: uuid("id").defaultRandom().primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  amountCents: integer("amount_cents").notNull(),
  runningBalanceCents: integer("running_balance_cents").notNull(),
  referenceType: text("reference_type"),
  referenceId: uuid("reference_id"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Disputes ────────────────────────────────────────────────────────────────

export const disputes = pgTable("marketplace_disputes", {
  id: uuid("id").defaultRandom().primaryKey(),
  subOrderId: uuid("sub_order_id").notNull().references(() => vendorSubOrders.id, { onDelete: "cascade" }),
  openedBy: text("opened_by").notNull(),
  reason: text("reason").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"),
  resolution: text("resolution"),
  resolutionNotes: text("resolution_notes"),
  refundAmountCents: integer("refund_amount_cents"),
  evidence: jsonb("evidence").$type<Array<{ party: string; type: string; url?: string; note?: string; at: string }>>().default([]),
  resolvedBy: text("resolved_by"),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ─── Vendor Reviews ──────────────────────────────────────────────────────────

export const vendorReviews = pgTable("marketplace_vendor_reviews", {
  id: uuid("id").defaultRandom().primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id"),
  orderId: uuid("order_id"),
  rating: integer("rating").notNull(),
  title: text("title"),
  body: text("body"),
  status: text("status").notNull().default("published"),
  vendorResponse: text("vendor_response"),
  vendorRespondedAt: timestamp("vendor_responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Return Requests ─────────────────────────────────────────────────────────

export const returnRequests = pgTable("marketplace_return_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  subOrderId: uuid("sub_order_id").notNull().references(() => vendorSubOrders.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id"),
  reason: text("reason").notNull(),
  description: text("description"),
  status: text("status").notNull().default("requested"),
  lineItems: jsonb("line_items").$type<Array<{ entityId: string; quantity: number; reason?: string }>>(),
  refundAmountCents: integer("refund_amount_cents"),
  vendorNotes: text("vendor_notes"),
  trackingNumber: text("tracking_number"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// ─── RFQ (B2B) ──────────────────────────────────────────────────────────────

export const rfqs = pgTable("marketplace_rfq", {
  id: uuid("id").defaultRandom().primaryKey(),
  buyerId: uuid("buyer_id"),
  title: text("title").notNull(),
  description: text("description"),
  categorySlug: text("category_slug"),
  quantity: integer("quantity"),
  budgetCents: integer("budget_cents"),
  currency: text("currency").notNull().default("USD"),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  status: text("status").notNull().default("open"),
  awardedVendorId: uuid("awarded_vendor_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const rfqResponses = pgTable("marketplace_rfq_responses", {
  id: uuid("id").defaultRandom().primaryKey(),
  rfqId: uuid("rfq_id").notNull().references(() => rfqs.id, { onDelete: "cascade" }),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  unitPriceCents: integer("unit_price_cents").notNull(),
  totalPriceCents: integer("total_price_cents").notNull(),
  leadTimeDays: integer("lead_time_days"),
  notes: text("notes"),
  status: text("status").notNull().default("submitted"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Contract Prices (B2B) ───────────────────────────────────────────────────

export const contractPrices = pgTable("marketplace_contract_prices", {
  id: uuid("id").defaultRandom().primaryKey(),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id, { onDelete: "cascade" }),
  buyerId: uuid("buyer_id").notNull(),
  entityId: uuid("entity_id").notNull(),
  variantId: uuid("variant_id"),
  priceCents: integer("price_cents").notNull(),
  minQuantity: integer("min_quantity").notNull().default(1),
  currency: text("currency").notNull().default("USD"),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
