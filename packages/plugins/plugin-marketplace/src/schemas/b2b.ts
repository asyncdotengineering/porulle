import { z } from "@hono/zod-openapi";

// ─── Create RFQ ─────────────────────────────────────────────────────────────

export const CreateRFQBodySchema = z.object({
  title: z.string().min(1).openapi({ example: "Bulk order: 500 widgets" }),
  buyerId: z.string().optional(),
  description: z.string().optional(),
  categorySlug: z.string().optional(),
  quantity: z.number().int().optional().openapi({ example: 500 }),
  budgetCents: z.number().int().optional().openapi({ example: 500000 }),
  currency: z.string().optional().openapi({ example: "USD" }),
  deadlineAt: z.string().optional().openapi({ example: "2026-04-01T00:00:00Z", description: "ISO 8601 date string" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateRFQRequest");

// ─── Respond to RFQ ─────────────────────────────────────────────────────────

export const RespondRFQBodySchema = z.object({
  vendorId: z.string().min(1).openapi({ example: "vendor_abc" }),
  unitPriceCents: z.number().int().openapi({ example: 800 }),
  totalPriceCents: z.number().int().openapi({ example: 400000 }),
  leadTimeDays: z.number().int().optional().openapi({ example: 14 }),
  notes: z.string().optional(),
}).openapi("RespondRFQRequest");

// ─── Award RFQ ──────────────────────────────────────────────────────────────

export const AwardRFQBodySchema = z.object({
  vendorId: z.string().min(1).openapi({ example: "vendor_abc" }),
}).openapi("AwardRFQRequest");
