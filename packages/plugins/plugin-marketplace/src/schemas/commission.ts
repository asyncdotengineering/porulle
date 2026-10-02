import { z } from "@hono/zod-openapi";

// ─── Create Commission Rule ──────────────────────────────────────────────────

export const CreateCommissionRuleBodySchema = z.object({
  name: z.string().min(1).openapi({ example: "Electronics Category Rate" }),
  type: z.enum(["category", "volume_tier", "vendor_tier", "promotional"]).openapi({ example: "category" }),
  rateBps: z.number().int().min(0).max(10000).openapi({ example: 1500, description: "Basis points (100 = 1%)" }),
  categorySlug: z.string().optional(),
  vendorId: z.uuid().optional(),
  vendorTier: z.string().optional(),
  minVolumeCents: z.number().int().optional(),
  maxVolumeCents: z.number().int().optional(),
  validFrom: z.string().optional().openapi({ example: "2026-01-01T00:00:00Z", description: "ISO 8601 date string" }),
  validUntil: z.string().optional().openapi({ example: "2026-12-31T23:59:59Z", description: "ISO 8601 date string" }),
  priority: z.number().int().optional(),
}).openapi("CreateCommissionRuleRequest");

// ─── Update Commission Rule ──────────────────────────────────────────────────

export const UpdateCommissionRuleBodySchema = z.object({
  name: z.string().min(1).optional(),
  rateBps: z.number().int().min(0).max(10000).optional(),
  categorySlug: z.string().nullable().optional(),
  vendorTier: z.string().nullable().optional(),
  minVolumeCents: z.number().int().nullable().optional(),
  maxVolumeCents: z.number().int().nullable().optional(),
  validFrom: z.string().nullable().optional().openapi({ description: "ISO 8601 date string or null to clear" }),
  validUntil: z.string().nullable().optional().openapi({ description: "ISO 8601 date string or null to clear" }),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
}).openapi("UpdateCommissionRuleRequest");

// ─── Preview Commission Rate ─────────────────────────────────────────────────

export const PreviewCommissionBodySchema = z.object({
  vendorId: z.uuid().openapi({ example: "d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a" }),
  categorySlug: z.string().optional(),
  volumeCents: z.number().int().optional().openapi({ example: 100000, description: "Order volume in cents" }),
}).openapi("PreviewCommissionRequest");

// ─── List Commission Rules ──────────────────────────────────────────────────

// ─── Delete Commission Rule ─────────────────────────────────────────────────
