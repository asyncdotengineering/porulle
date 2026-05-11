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

const SubOrderResponseSchema = z.object({ data: z.any() });

// ─── Update Sub-Order Status ─────────────────────────────────────────────────

export const UpdateSubOrderStatusBodySchema = z.object({
  status: z.enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"])
    .openapi({ example: "processing" }),
  reason: z.string().optional().openapi({ example: "Admin force status change" }),
}).openapi("UpdateSubOrderStatusRequest");

export const updateSubOrderStatusRoute = createRoute({
  method: "patch",
  path: "/api/marketplace/sub-orders/{id}/status",
  tags: ["Marketplace - Sub-Orders"],
  summary: "Force a sub-order status change",
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { "application/json": { schema: UpdateSubOrderStatusBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: SubOrderResponseSchema } }, description: "Sub-order status updated." },
    ...errorResponses,
  },
});

// ─── List Sub-Orders ────────────────────────────────────────────────────────

export const listSubOrdersRoute = createRoute({
  method: "get",
  path: "/api/marketplace/sub-orders",
  tags: ["Marketplace - Sub-Orders"],
  summary: "List sub-orders",
  request: {
    query: z.object({
      orderId: z.string().optional(),
      vendorId: z.string().optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: SubOrderResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Get Sub-Order ──────────────────────────────────────────────────────────

export const getSubOrderRoute = createRoute({
  method: "get",
  path: "/api/marketplace/sub-orders/{id}",
  tags: ["Marketplace - Sub-Orders"],
  summary: "Get sub-order by ID",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: SubOrderResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});
