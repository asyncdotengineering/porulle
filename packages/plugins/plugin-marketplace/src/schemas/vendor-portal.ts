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

// ─── Update Vendor Profile ──────────────────────────────────────────────────

export const UpdateVendorProfileBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateVendorProfileRequest");

export const updateVendorProfileRoute = createRoute({
  method: "patch",
  path: "/api/marketplace/vendor/me",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Update my vendor profile",
  request: {
    body: { content: { "application/json": { schema: UpdateVendorProfileBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Profile updated." },
    ...errorResponses,
  },
});

// ─── Upload Document ────────────────────────────────────────────────────────

export const UploadVendorDocumentBodySchema = z.object({
  type: z.string().min(1).openapi({ example: "business_license" }),
  fileUrl: z.string().url().openapi({ example: "https://storage.example.com/doc.pdf" }),
}).openapi("UploadVendorPortalDocumentRequest");

export const uploadVendorDocumentRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/documents",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Upload a document for my vendor profile",
  request: {
    body: { content: { "application/json": { schema: UploadVendorDocumentBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponseSchema } }, description: "Document uploaded." },
    ...errorResponses,
  },
});

// ─── Confirm Sub-Order ──────────────────────────────────────────────────────

export const ConfirmSubOrderBodySchema = z.object({}).openapi("ConfirmSubOrderRequest");

export const confirmSubOrderRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/orders/{subOrderId}/confirm",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Confirm a sub-order",
  request: {
    params: z.object({ subOrderId: z.uuid() }),
    body: { content: { "application/json": { schema: ConfirmSubOrderBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Sub-order confirmed." },
    ...errorResponses,
  },
});

// ─── Ship Sub-Order ─────────────────────────────────────────────────────────

export const ShipSubOrderBodySchema = z.object({
  trackingNumber: z.string().min(1).openapi({ example: "1Z999AA10123456784" }),
  carrier: z.string().min(1).openapi({ example: "UPS" }),
}).openapi("ShipSubOrderRequest");

export const shipSubOrderRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/orders/{subOrderId}/ship",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Ship a sub-order",
  request: {
    params: z.object({ subOrderId: z.uuid() }),
    body: { content: { "application/json": { schema: ShipSubOrderBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Sub-order shipped." },
    ...errorResponses,
  },
});

// ─── Deliver Sub-Order ──────────────────────────────────────────────────────

export const DeliverSubOrderBodySchema = z.object({}).openapi("DeliverSubOrderRequest");

export const deliverSubOrderRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/orders/{subOrderId}/deliver",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Mark a sub-order as delivered",
  request: {
    params: z.object({ subOrderId: z.uuid() }),
    body: { content: { "application/json": { schema: DeliverSubOrderBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Sub-order delivered." },
    ...errorResponses,
  },
});

// ─── Cancel Sub-Order ───────────────────────────────────────────────────────

export const CancelSubOrderBodySchema = z.object({
  reason: z.string().min(1).openapi({ example: "Out of stock" }),
}).openapi("CancelSubOrderRequest");

export const cancelSubOrderRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/orders/{subOrderId}/cancel",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Cancel a sub-order",
  request: {
    params: z.object({ subOrderId: z.uuid() }),
    body: { content: { "application/json": { schema: CancelSubOrderBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Sub-order cancelled." },
    ...errorResponses,
  },
});

// ─── Respond to Review ──────────────────────────────────────────────────────

export const RespondToReviewBodySchema = z.object({
  response: z.string().min(1).openapi({ example: "Thank you for your feedback!" }),
}).openapi("RespondToReviewRequest");

export const respondToReviewRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/reviews/{id}/respond",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Respond to a review",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: RespondToReviewBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Response submitted." },
    ...errorResponses,
  },
});

// ─── Approve Return ─────────────────────────────────────────────────────────

export const ApproveReturnBodySchema = z.object({
  refundAmountCents: z.number().int().min(0).optional(),
}).openapi("ApproveReturnRequest");

export const approveReturnRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/returns/{id}/approve",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Approve a return request",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: ApproveReturnBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Return approved." },
    ...errorResponses,
  },
});

// ─── Reject Return ──────────────────────────────────────────────────────────

export const RejectReturnBodySchema = z.object({
  notes: z.string().optional(),
}).openapi("RejectReturnRequest");

export const rejectReturnRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendor/me/returns/{id}/reject",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Reject a return request",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: RejectReturnBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Return rejected." },
    ...errorResponses,
  },
});

// ─── Get My Vendor Profile ──────────────────────────────────────────────────

export const getMyVendorProfileRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Get my vendor profile",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── List My Documents ──────────────────────────────────────────────────────

export const listMyDocumentsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/documents",
  tags: ["Marketplace - Vendor Portal"],
  summary: "List my vendor documents",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── List My Products ───────────────────────────────────────────────────────

export const listMyProductsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/products",
  tags: ["Marketplace - Vendor Portal"],
  summary: "List my products",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── List My Sub-Orders ─────────────────────────────────────────────────────

export const listMyOrdersRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/orders",
  tags: ["Marketplace - Vendor Portal"],
  summary: "List my sub-orders",
  request: {
    query: z.object({
      status: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Get Single Sub-Order ───────────────────────────────────────────────────

export const getMyOrderRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/orders/{subOrderId}",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Get a single sub-order",
  request: {
    params: z.object({ subOrderId: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── List My Payouts ────────────────────────────────────────────────────────

export const listMyPayoutsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/payouts",
  tags: ["Marketplace - Vendor Portal"],
  summary: "List my payouts",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── My Balance ─────────────────────────────────────────────────────────────

export const myBalanceRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/balance",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Get my balance",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── My Analytics ───────────────────────────────────────────────────────────

export const myAnalyticsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/analytics",
  tags: ["Marketplace - Vendor Portal"],
  summary: "Get my analytics",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── My Reviews ─────────────────────────────────────────────────────────────

export const myReviewsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/reviews",
  tags: ["Marketplace - Vendor Portal"],
  summary: "List my reviews",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── My Returns ─────────────────────────────────────────────────────────────

export const myReturnsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendor/me/returns",
  tags: ["Marketplace - Vendor Portal"],
  summary: "List my returns",
  responses: {
    200: { content: { "application/json": { schema: DataResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});
