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

const DataResponseSchema = z.object({ data: z.any() });

// ═══════════════════════════════════════════════════════════════════════════════
// RFQ (Request for Quote)
// ═══════════════════════════════════════════════════════════════════════════════

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

export const createRFQRoute = createRoute({
  method: "post",
  path: "/api/marketplace/rfq",
  tags: ["Marketplace - B2B"],
  summary: "Create a Request for Quote",
  request: {
    body: { content: { "application/json": { schema: CreateRFQBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponseSchema } }, description: "RFQ created." },
    ...errorResponses,
  },
});

// ─── Respond to RFQ ─────────────────────────────────────────────────────────

export const RespondRFQBodySchema = z.object({
  vendorId: z.string().min(1).openapi({ example: "vendor_abc" }),
  unitPriceCents: z.number().int().openapi({ example: 800 }),
  totalPriceCents: z.number().int().openapi({ example: 400000 }),
  leadTimeDays: z.number().int().optional().openapi({ example: 14 }),
  notes: z.string().optional(),
}).openapi("RespondRFQRequest");

export const respondRFQRoute = createRoute({
  method: "post",
  path: "/api/marketplace/rfq/{id}/respond",
  tags: ["Marketplace - B2B"],
  summary: "Submit a vendor response to an RFQ",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: RespondRFQBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponseSchema } }, description: "RFQ response submitted." },
    ...errorResponses,
  },
});

// ─── Award RFQ ──────────────────────────────────────────────────────────────

export const AwardRFQBodySchema = z.object({
  vendorId: z.string().min(1).openapi({ example: "vendor_abc" }),
}).openapi("AwardRFQRequest");

export const awardRFQRoute = createRoute({
  method: "post",
  path: "/api/marketplace/rfq/{id}/award",
  tags: ["Marketplace - B2B"],
  summary: "Award an RFQ to a vendor",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: AwardRFQBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "RFQ awarded." },
    ...errorResponses,
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// CONTRACT PRICES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Create Contract Price ──────────────────────────────────────────────────

export const CreateContractPriceBodySchema = z.object({
  vendorId: z.string().min(1).openapi({ example: "vendor_abc" }),
  buyerId: z.string().min(1).openapi({ example: "buyer_xyz" }),
  entityId: z.string().min(1).openapi({ example: "product_001" }),
  variantId: z.string().optional(),
  priceCents: z.number().int().openapi({ example: 7500 }),
  minQuantity: z.number().int().optional().openapi({ example: 100 }),
  currency: z.string().optional().openapi({ example: "USD" }),
  validFrom: z.string().optional().openapi({ example: "2026-01-01T00:00:00Z", description: "ISO 8601 date string" }),
  validUntil: z.string().optional().openapi({ example: "2026-12-31T23:59:59Z", description: "ISO 8601 date string" }),
}).openapi("CreateContractPriceRequest");

export const createContractPriceRoute = createRoute({
  method: "post",
  path: "/api/marketplace/contract-prices",
  tags: ["Marketplace - B2B"],
  summary: "Create a contract price",
  request: {
    body: { content: { "application/json": { schema: CreateContractPriceBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponseSchema } }, description: "Contract price created." },
    ...errorResponses,
  },
});

// ─── Update Contract Price ──────────────────────────────────────────────────

export const UpdateContractPriceBodySchema = z.object({
  priceCents: z.number().int().optional().openapi({ example: 7000 }),
  minQuantity: z.number().int().optional(),
  validFrom: z.string().nullable().optional().openapi({ description: "ISO 8601 date string or null to clear" }),
  validUntil: z.string().nullable().optional().openapi({ description: "ISO 8601 date string or null to clear" }),
}).openapi("UpdateContractPriceRequest");

export const updateContractPriceRoute = createRoute({
  method: "patch",
  path: "/api/marketplace/contract-prices/{id}",
  tags: ["Marketplace - B2B"],
  summary: "Update a contract price",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: UpdateContractPriceBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Contract price updated." },
    ...errorResponses,
  },
});

// ─── List RFQs ──────────────────────────────────────────────────────────────

export const listRFQsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/rfq",
  tags: ["Marketplace - B2B"],
  summary: "List Requests for Quote",
  request: {
    query: z.object({
      status: z.string().optional(),
      categorySlug: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Get RFQ ────────────────────────────────────────────────────────────────

export const getRFQRoute = createRoute({
  method: "get",
  path: "/api/marketplace/rfq/{id}",
  tags: ["Marketplace - B2B"],
  summary: "Get RFQ detail",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Close RFQ ──────────────────────────────────────────────────────────────

export const closeRFQRoute = createRoute({
  method: "post",
  path: "/api/marketplace/rfq/{id}/close",
  tags: ["Marketplace - B2B"],
  summary: "Close an RFQ",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "RFQ closed." },
    ...errorResponses,
  },
});

// ─── List Contract Prices ───────────────────────────────────────────────────

export const listContractPricesRoute = createRoute({
  method: "get",
  path: "/api/marketplace/contract-prices",
  tags: ["Marketplace - B2B"],
  summary: "List contract prices",
  request: {
    query: z.object({
      vendorId: z.string().optional(),
      buyerId: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Delete Contract Price ──────────────────────────────────────────────────

export const deleteContractPriceRoute = createRoute({
  method: "delete",
  path: "/api/marketplace/contract-prices/{id}",
  tags: ["Marketplace - B2B"],
  summary: "Delete a contract price",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Contract price deleted." },
    ...errorResponses,
  },
});
