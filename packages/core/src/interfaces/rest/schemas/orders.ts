import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses } from "./shared.js";
import { OrderResponse, OrderListResponse } from "./responses.js";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const ChangeOrderStatusBodySchema = z.object({
  // Accept any string — custom state machines (e.g., BNPL) add states like
  // "payment_initiated", "shipped", "delivered" etc. The order service's
  // state machine validates valid transitions at runtime.
  status: z.string().min(1).openapi({ example: "confirmed" }),
  reason: z.string().optional().openapi({ example: "Payment verified" }),
}).openapi("ChangeOrderStatusRequest");

// ─── Response Schemas ───────────────────────────────────────────────────────

export const OrderDataResponseSchema = OrderResponse;

// ─── Path Params ────────────────────────────────────────────────────────────

const OrderIdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

// ─── Route Definitions ──────────────────────────────────────────────────────

export const listOrdersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Orders"],
  summary: "List orders",
  request: {
    query: z.object({
      status: z.string().optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderListResponse } },
      description: "Success",
    },
  },
});

export const getOrderRoute = createRoute({
  method: "get",
  path: "/{idOrNumber}",
  tags: ["Orders"],
  summary: "Get an order by ID or order number",
  request: {
    params: z.object({
      idOrNumber: z.string().min(1).openapi({ example: "ORD-001" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Success",
    },
    ...errorResponses,
  },
});

export const getOrderFulfillmentsRoute = createRoute({
  method: "get",
  path: "/{id}/fulfillments",
  tags: ["Orders"],
  summary: "Get fulfillments for an order",
  request: {
    params: OrderIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Success",
    },
    ...errorResponses,
  },
});

export const changeOrderStatusRoute = createRoute({
  method: "patch",
  path: "/{id}/status",
  tags: ["Orders"],
  summary: "Change the status of an order",
  request: {
    params: OrderIdParam,
    body: {
      content: {
        "application/json": { schema: ChangeOrderStatusBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Order status updated.",
    },
    ...errorResponses,
  },
});
