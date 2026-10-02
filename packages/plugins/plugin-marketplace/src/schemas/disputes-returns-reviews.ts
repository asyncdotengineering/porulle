import { z } from "@hono/zod-openapi";

// ═══════════════════════════════════════════════════════════════════════════════
// DISPUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Open Dispute ───────────────────────────────────────────────────────────

export const OpenDisputeBodySchema = z.object({
  subOrderId: z.string().min(1).openapi({ example: "sub_abc123" }),
  openedBy: z.string().min(1).openapi({ example: "user_xyz" }),
  reason: z.string().min(1).openapi({ example: "item_not_received" }),
  description: z.string().optional(),
}).openapi("OpenDisputeRequest");

// ─── Respond to Dispute ─────────────────────────────────────────────────────

export const RespondDisputeBodySchema = z.object({
  party: z.string().min(1).openapi({ example: "vendor" }),
  note: z.string().min(1).openapi({ example: "We shipped the item on time." }),
  url: z.string().url().optional().openapi({ example: "https://example.com/evidence.pdf" }),
}).openapi("RespondDisputeRequest");

// ─── Resolve Dispute ────────────────────────────────────────────────────────

export const ResolveDisputeBodySchema = z.object({
  resolution: z.enum([
    "refund_full", "refund_partial", "replacement", "rejected", "vendor_favor", "buyer_favor",
  ]).openapi({ example: "refund_full" }),
  resolvedBy: z.string().min(1).openapi({ example: "admin_001" }),
  notes: z.string().optional(),
  refundAmountCents: z.number().int().optional().openapi({ example: 1500 }),
}).openapi("ResolveDisputeRequest");

// ═══════════════════════════════════════════════════════════════════════════════
// RETURNS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Request Return ─────────────────────────────────────────────────────────

export const RequestReturnBodySchema = z.object({
  subOrderId: z.string().min(1).openapi({ example: "sub_abc123" }),
  reason: z.string().min(1).openapi({ example: "defective" }),
  customerId: z.string().optional(),
  description: z.string().optional(),
  lineItems: z.array(z.record(z.string(), z.unknown())).optional(),
}).openapi("RequestReturnRequest");

// ─── Ship Back ──────────────────────────────────────────────────────────────

export const ShipBackReturnBodySchema = z.object({
  trackingNumber: z.string().min(1).openapi({ example: "TRACK123456" }),
}).openapi("ShipBackReturnRequest");

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEWS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Create Review ──────────────────────────────────────────────────────────

export const CreateReviewBodySchema = z.object({
  rating: z.number().int().min(1).max(5).openapi({ example: 4 }),
  customerId: z.string().optional(),
  orderId: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
}).openapi("CreateVendorReviewRequest");

// ─── Moderate Review ────────────────────────────────────────────────────────

export const ModerateReviewBodySchema = z.object({
  status: z.enum(["pending", "published", "hidden", "flagged"]).openapi({ example: "published" }),
}).openapi("ModerateReviewRequest");

// ─── List Disputes ──────────────────────────────────────────────────────────

// ─── Get Dispute ────────────────────────────────────────────────────────────

// ─── Escalate Dispute ───────────────────────────────────────────────────────

// ─── List Returns ───────────────────────────────────────────────────────────

// ─── Get Return ─────────────────────────────────────────────────────────────

// ─── Receive Return ─────────────────────────────────────────────────────────

// ─── List Vendor Reviews ────────────────────────────────────────────────────
