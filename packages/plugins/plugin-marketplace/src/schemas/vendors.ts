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

const VendorResponseSchema = z.object({ data: z.any() });

// ─── Create Vendor ───────────────────────────────────────────────────────────

export const CreateVendorBodySchema = z.object({
  name: z.string().min(1).openapi({ example: "Acme Co" }),
  slug: z.string().optional(),
  contactEmail: z.string().email().optional(),
  commissionRateBps: z.number().int().min(0).max(10000).optional()
    .openapi({ example: 1000, description: "Basis points (100 = 1%)" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateVendorRequest");

export const createVendorRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors",
  tags: ["Marketplace - Vendors"],
  summary: "Create a vendor",
  request: {
    body: { content: { "application/json": { schema: CreateVendorBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Vendor created." },
    ...errorResponses,
  },
});

// ─── Update Vendor ───────────────────────────────────────────────────────────

export const UpdateVendorBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  contactEmail: z.string().email().optional(),
  commissionRateBps: z.number().int().min(0).max(10000).optional(),
  tier: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateVendorRequest");

export const updateVendorRoute = createRoute({
  method: "patch",
  path: "/api/marketplace/vendors/{id}",
  tags: ["Marketplace - Vendors"],
  summary: "Update a vendor",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: UpdateVendorBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Vendor updated." },
    ...errorResponses,
  },
});

// ─── Reject Vendor ───────────────────────────────────────────────────────────

export const RejectVendorBodySchema = z.object({
  reason: z.string().min(1).openapi({ example: "Incomplete documentation" }),
}).openapi("RejectVendorRequest");

export const rejectVendorRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/reject",
  tags: ["Marketplace - Vendors"],
  summary: "Reject a vendor application",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: RejectVendorBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Vendor rejected." },
    ...errorResponses,
  },
});

// ─── Suspend Vendor ──────────────────────────────────────────────────────────

export const SuspendVendorBodySchema = z.object({
  reason: z.string().min(1).openapi({ example: "Policy violation" }),
}).openapi("SuspendVendorRequest");

export const suspendVendorRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/suspend",
  tags: ["Marketplace - Vendors"],
  summary: "Suspend a vendor",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: SuspendVendorBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Vendor suspended." },
    ...errorResponses,
  },
});

// ─── Upload Document ─────────────────────────────────────────────────────────

export const UploadDocumentBodySchema = z.object({
  type: z.string().min(1).openapi({ example: "business_license" }),
  fileUrl: z.string().url().openapi({ example: "https://storage.example.com/doc.pdf" }),
}).openapi("UploadVendorDocumentRequest");

export const uploadDocumentRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/documents",
  tags: ["Marketplace - Vendors"],
  summary: "Upload a vendor document",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: UploadDocumentBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Document uploaded." },
    ...errorResponses,
  },
});

// ─── List Vendors ───────────────────────────────────────────────────────────

export const listVendorsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendors",
  tags: ["Marketplace - Vendors"],
  summary: "List all vendors",
  request: {
    query: z.object({
      status: z.string().optional(),
      tier: z.string().optional(),
      search: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Get Vendor ─────────────────────────────────────────────────────────────

export const getVendorRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendors/{id}",
  tags: ["Marketplace - Vendors"],
  summary: "Get vendor detail",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Approve Vendor ─────────────────────────────────────────────────────────

export const approveVendorRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/approve",
  tags: ["Marketplace - Vendors"],
  summary: "Approve a vendor application",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Vendor approved." },
    ...errorResponses,
  },
});

// ─── Reinstate Vendor ───────────────────────────────────────────────────────

export const reinstateVendorRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/reinstate",
  tags: ["Marketplace - Vendors"],
  summary: "Reinstate a suspended vendor",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Vendor reinstated." },
    ...errorResponses,
  },
});

// ─── List Vendor Documents ──────────────────────────────────────────────────

export const listVendorDocumentsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendors/{id}/documents",
  tags: ["Marketplace - Vendors"],
  summary: "List vendor documents",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Approve Document ───────────────────────────────────────────────────────

export const approveDocumentRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/documents/{docId}/approve",
  tags: ["Marketplace - Vendors"],
  summary: "Approve a vendor document",
  request: {
    params: z.object({ id: z.uuid(), docId: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Document approved." },
    ...errorResponses,
  },
});

// ─── Reject Document ────────────────────────────────────────────────────────

export const rejectDocumentRoute = createRoute({
  method: "post",
  path: "/api/marketplace/vendors/{id}/documents/{docId}/reject",
  tags: ["Marketplace - Vendors"],
  summary: "Reject a vendor document",
  request: {
    params: z.object({ id: z.uuid(), docId: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Document rejected." },
    ...errorResponses,
  },
});

// ─── Vendor Balance ─────────────────────────────────────────────────────────

export const vendorBalanceRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendors/{id}/balance",
  tags: ["Marketplace - Vendors"],
  summary: "Get vendor balance",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Vendor Performance ─────────────────────────────────────────────────────

export const vendorPerformanceRoute = createRoute({
  method: "get",
  path: "/api/marketplace/vendors/{id}/performance",
  tags: ["Marketplace - Vendors"],
  summary: "Get vendor performance metrics",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: VendorResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});
