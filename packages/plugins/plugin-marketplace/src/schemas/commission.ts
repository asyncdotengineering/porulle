import { z, createRoute } from "@hono/zod-openapi";

const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const errorResponses = {
  401: { content: { "application/json": { schema: ErrorSchema } }, description: "Authentication required." },
  403: { content: { "application/json": { schema: ErrorSchema } }, description: "Insufficient permissions." },
  404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found." },
  422: { content: { "application/json": { schema: ErrorSchema } }, description: "Validation error." },
  500: { content: { "application/json": { schema: ErrorSchema } }, description: "Server error." },
} as const;

const CommissionResponseSchema = z.object({ data: z.any() });

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

export const createCommissionRuleRoute = createRoute({
  method: "post",
  path: "/api/marketplace/commission-rules",
  tags: ["Marketplace - Commission"],
  summary: "Create a commission rule",
  request: {
    body: { content: { "application/json": { schema: CreateCommissionRuleBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: CommissionResponseSchema } }, description: "Commission rule created." },
    ...errorResponses,
  },
});

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

export const updateCommissionRuleRoute = createRoute({
  method: "patch",
  path: "/api/marketplace/commission-rules/{id}",
  tags: ["Marketplace - Commission"],
  summary: "Update a commission rule",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: UpdateCommissionRuleBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: CommissionResponseSchema } }, description: "Commission rule updated." },
    ...errorResponses,
  },
});

// ─── Preview Commission Rate ─────────────────────────────────────────────────

export const PreviewCommissionBodySchema = z.object({
  vendorId: z.uuid().openapi({ example: "d4e5f6a7-b8c9-0d1e-2f3a-4b5c6d7e8f9a" }),
  categorySlug: z.string().optional(),
  volumeCents: z.number().int().optional().openapi({ example: 100000, description: "Order volume in cents" }),
}).openapi("PreviewCommissionRequest");

export const previewCommissionRoute = createRoute({
  method: "post",
  path: "/api/marketplace/commission-rules/preview",
  tags: ["Marketplace - Commission"],
  summary: "Preview the commission rate for a vendor",
  request: {
    body: { content: { "application/json": { schema: PreviewCommissionBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: CommissionResponseSchema } }, description: "Commission rate preview." },
    ...errorResponses,
  },
});

// ─── List Commission Rules ──────────────────────────────────────────────────

export const listCommissionRulesRoute = createRoute({
  method: "get",
  path: "/api/marketplace/commission-rules",
  tags: ["Marketplace - Commission"],
  summary: "List all commission rules",
  responses: {
    200: { content: { "application/json": { schema: CommissionResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Delete Commission Rule ─────────────────────────────────────────────────

export const deleteCommissionRuleRoute = createRoute({
  method: "delete",
  path: "/api/marketplace/commission-rules/{id}",
  tags: ["Marketplace - Commission"],
  summary: "Delete a commission rule",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: CommissionResponseSchema } }, description: "Commission rule deleted." },
    ...errorResponses,
  },
});
