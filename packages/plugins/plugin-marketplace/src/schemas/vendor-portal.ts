import { z } from "@hono/zod-openapi";

// ─── Update Vendor Profile ──────────────────────────────────────────────────

export const UpdateVendorProfileBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateVendorProfileRequest");

// ─── Upload Document ────────────────────────────────────────────────────────

export const UploadVendorDocumentBodySchema = z.object({
  type: z.string().min(1).openapi({ example: "business_license" }),
  fileUrl: z.string().url().openapi({ example: "https://storage.example.com/doc.pdf" }),
}).openapi("UploadVendorPortalDocumentRequest");

// ─── Confirm Sub-Order ──────────────────────────────────────────────────────

export const ConfirmSubOrderBodySchema = z.object({}).openapi("ConfirmSubOrderRequest");

// ─── Ship Sub-Order ─────────────────────────────────────────────────────────

export const ShipSubOrderBodySchema = z.object({
  trackingNumber: z.string().min(1).openapi({ example: "1Z999AA10123456784" }),
  carrier: z.string().min(1).openapi({ example: "UPS" }),
}).openapi("ShipSubOrderRequest");

// ─── Deliver Sub-Order ──────────────────────────────────────────────────────

export const DeliverSubOrderBodySchema = z.object({}).openapi("DeliverSubOrderRequest");

// ─── Cancel Sub-Order ───────────────────────────────────────────────────────

export const CancelSubOrderBodySchema = z.object({
  reason: z.string().min(1).openapi({ example: "Out of stock" }),
}).openapi("CancelSubOrderRequest");

// ─── Respond to Review ──────────────────────────────────────────────────────

export const RespondToReviewBodySchema = z.object({
  response: z.string().min(1).openapi({ example: "Thank you for your feedback!" }),
}).openapi("RespondToReviewRequest");

// ─── Approve Return ─────────────────────────────────────────────────────────

export const ApproveReturnBodySchema = z.object({
  refundAmountCents: z.number().int().min(0).optional(),
}).openapi("ApproveReturnRequest");

// ─── Reject Return ──────────────────────────────────────────────────────────

export const RejectReturnBodySchema = z.object({
  notes: z.string().optional(),
}).openapi("RejectReturnRequest");

// ─── Get My Vendor Profile ──────────────────────────────────────────────────

// ─── List My Documents ──────────────────────────────────────────────────────

// ─── List My Products ───────────────────────────────────────────────────────

// ─── List My Sub-Orders ─────────────────────────────────────────────────────

// ─── Get Single Sub-Order ───────────────────────────────────────────────────

// ─── List My Payouts ────────────────────────────────────────────────────────

// ─── My Balance ─────────────────────────────────────────────────────────────

// ─── My Analytics ───────────────────────────────────────────────────────────

// ─── My Reviews ─────────────────────────────────────────────────────────────

// ─── My Returns ─────────────────────────────────────────────────────────────
