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
// DISPUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Open Dispute ───────────────────────────────────────────────────────────

export const OpenDisputeBodySchema = z.object({
  subOrderId: z.string().min(1).openapi({ example: "sub_abc123" }),
  openedBy: z.string().min(1).openapi({ example: "user_xyz" }),
  reason: z.string().min(1).openapi({ example: "item_not_received" }),
  description: z.string().optional(),
}).openapi("OpenDisputeRequest");

export const openDisputeRoute = createRoute({
  method: "post",
  path: "/api/marketplace/disputes",
  tags: ["Marketplace - Disputes"],
  summary: "Open a dispute",
  request: {
    body: { content: { "application/json": { schema: OpenDisputeBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponseSchema } }, description: "Dispute opened." },
    ...errorResponses,
  },
});

// ─── Respond to Dispute ─────────────────────────────────────────────────────

export const RespondDisputeBodySchema = z.object({
  party: z.string().min(1).openapi({ example: "vendor" }),
  note: z.string().min(1).openapi({ example: "We shipped the item on time." }),
  url: z.string().url().optional().openapi({ example: "https://example.com/evidence.pdf" }),
}).openapi("RespondDisputeRequest");

export const respondDisputeRoute = createRoute({
  method: "post",
  path: "/api/marketplace/disputes/{id}/respond",
  tags: ["Marketplace - Disputes"],
  summary: "Respond to a dispute",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: RespondDisputeBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Response recorded." },
    ...errorResponses,
  },
});

// ─── Resolve Dispute ────────────────────────────────────────────────────────

export const ResolveDisputeBodySchema = z.object({
  resolution: z.enum([
    "refund_full", "refund_partial", "replacement", "rejected", "vendor_favor", "buyer_favor",
  ]).openapi({ example: "refund_full" }),
  resolvedBy: z.string().min(1).openapi({ example: "admin_001" }),
  notes: z.string().optional(),
  refundAmountCents: z.number().int().optional().openapi({ example: 1500 }),
}).openapi("ResolveDisputeRequest");

export const resolveDisputeRoute = createRoute({
  method: "post",
  path: "/api/marketplace/disputes/{id}/resolve",
  tags: ["Marketplace - Disputes"],
  summary: "Resolve a dispute",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: ResolveDisputeBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Dispute resolved." },
    ...errorResponses,
  },
});

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

export const requestReturnRoute = createRoute({
  method: "post",
  path: "/api/marketplace/returns",
  tags: ["Marketplace - Returns"],
  summary: "Request a return",
  request: {
    body: { content: { "application/json": { schema: RequestReturnBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponseSchema } }, description: "Return requested." },
    ...errorResponses,
  },
});

// ─── Ship Back ──────────────────────────────────────────────────────────────

export const ShipBackReturnBodySchema = z.object({
  trackingNumber: z.string().min(1).openapi({ example: "TRACK123456" }),
}).openapi("ShipBackReturnRequest");

export const shipBackReturnRoute = createRoute({
  method: "post",
  path: "/api/marketplace/returns/{id}/ship-back",
  tags: ["Marketplace - Returns"],
  summary: "Ship back a return",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: ShipBackReturnBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Return shipped back." },
    ...errorResponses,
  },
});

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

export const createReviewRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/reviews",
  tags: ["Marketplace - Reviews"],
  summary: "Create a vendor review",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: CreateReviewBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponseSchema } }, description: "Review created." },
    ...errorResponses,
  },
});

// ─── Moderate Review ────────────────────────────────────────────────────────

export const ModerateReviewBodySchema = z.object({
  status: z.enum(["pending", "published", "hidden", "flagged"]).openapi({ example: "published" }),
}).openapi("ModerateReviewRequest");

export const moderateReviewRoute = createRoute({
  method: "patch",
  path: "/api/marketplace/reviews/{id}",
  tags: ["Marketplace - Reviews"],
  summary: "Moderate a review (update status)",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: ModerateReviewBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Review moderated." },
    ...errorResponses,
  },
});

// ─── List Disputes ──────────────────────────────────────────────────────────

export const listDisputesRoute = createRoute({
  method: "get",
  path: "/api/marketplace/disputes",
  tags: ["Marketplace - Disputes"],
  summary: "List disputes",
  request: {
    query: z.object({
      status: z.string().optional(),
      subOrderId: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Get Dispute ────────────────────────────────────────────────────────────

export const getDisputeRoute = createRoute({
  method: "get",
  path: "/api/marketplace/disputes/{id}",
  tags: ["Marketplace - Disputes"],
  summary: "Get dispute by ID",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Escalate Dispute ───────────────────────────────────────────────────────

export const escalateDisputeRoute = createRoute({
  method: "post",
  path: "/api/marketplace/disputes/{id}/escalate",
  tags: ["Marketplace - Disputes"],
  summary: "Escalate a dispute",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Dispute escalated." },
    ...errorResponses,
  },
});

// ─── List Returns ───────────────────────────────────────────────────────────

export const listReturnsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/returns",
  tags: ["Marketplace - Returns"],
  summary: "List returns",
  request: {
    query: z.object({
      subOrderId: z.string().optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Get Return ─────────────────────────────────────────────────────────────

export const getReturnRoute = createRoute({
  method: "get",
  path: "/api/marketplace/returns/{id}",
  tags: ["Marketplace - Returns"],
  summary: "Get return by ID",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Receive Return ─────────────────────────────────────────────────────────

export const receiveReturnRoute = createRoute({
  method: "post",
  path: "/api/marketplace/returns/{id}/receive",
  tags: ["Marketplace - Returns"],
  summary: "Mark a return as received",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Return received." },
    ...errorResponses,
  },
});

// ─── List Vendor Reviews ────────────────────────────────────────────────────

export const listVendorReviewsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendors/{id}/reviews",
  tags: ["Marketplace - Reviews"],
  summary: "List reviews for a vendor",
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});
