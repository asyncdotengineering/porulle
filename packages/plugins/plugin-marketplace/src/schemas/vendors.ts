import { z } from "@hono/zod-openapi";

// ─── Create Vendor ───────────────────────────────────────────────────────────

export const CreateVendorBodySchema = z.object({
  name: z.string().min(1).openapi({ example: "Acme Co" }),
  slug: z.string().optional(),
  contactEmail: z.string().email().optional(),
  commissionRateBps: z.number().int().min(0).max(10000).optional()
    .openapi({ example: 1000, description: "Basis points (100 = 1%)" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateVendorRequest");

// ─── Update Vendor ───────────────────────────────────────────────────────────

export const UpdateVendorBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional(),
  commissionRateBps: z.number().int().min(0).max(10000).optional(),
  tier: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateVendorRequest");

// ─── Reject Vendor ───────────────────────────────────────────────────────────

export const RejectVendorBodySchema = z.object({
  reason: z.string().min(1).openapi({ example: "Incomplete documentation" }),
}).openapi("RejectVendorRequest");

// ─── Suspend Vendor ──────────────────────────────────────────────────────────

export const SuspendVendorBodySchema = z.object({
  reason: z.string().min(1).openapi({ example: "Policy violation" }),
}).openapi("SuspendVendorRequest");

// ─── Upload Document ─────────────────────────────────────────────────────────

export const UploadDocumentBodySchema = z.object({
  type: z.string().min(1).openapi({ example: "business_license" }),
  fileUrl: z.string().url().openapi({ example: "https://storage.example.com/doc.pdf" }),
}).openapi("UploadVendorDocumentRequest");

// ─── List Vendors ───────────────────────────────────────────────────────────

// ─── Get Vendor ─────────────────────────────────────────────────────────────

// ─── Approve Vendor ─────────────────────────────────────────────────────────

// ─── Reinstate Vendor ───────────────────────────────────────────────────────

// ─── List Vendor Documents ──────────────────────────────────────────────────

// ─── Approve Document ───────────────────────────────────────────────────────

// ─── Reject Document ────────────────────────────────────────────────────────

// ─── Vendor Balance ─────────────────────────────────────────────────────────

// ─── Vendor Performance ─────────────────────────────────────────────────────
