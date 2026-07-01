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

export const RefundOrderBodySchema = z.object({
  // Minor units (e.g. cents). Omit to refund the full captured amount.
  amount: z.number().int().positive().optional().openapi({ example: 1575 }),
  reason: z.string().optional().openapi({ example: "Customer returned item" }),
}).openapi("RefundOrderRequest");

export const CaptureOrderBodySchema = z.object({
  // Minor units. Omit to capture the full authorized amount.
  amount: z.number().int().positive().optional().openapi({ example: 1575 }),
}).openapi("CaptureOrderRequest");

const CreateOrderLineItemSchema = z.object({
  entityId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  entityType: z.string().min(1).openapi({ example: "product" }),
  variantId: z.uuid().optional(),
  sku: z.string().optional(),
  title: z.string().min(1).openapi({ example: "Ceylon Black Tea 250g" }),
  quantity: z.number().int().positive().openapi({ example: 2 }),
  unitPrice: z.number().int().nonnegative().openapi({ example: 1250 }),
  totalPrice: z.number().int().nonnegative().openapi({ example: 2500 }),
  taxAmount: z.number().int().nonnegative().optional(),
  discountAmount: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CreateOrderBodySchema = z.object({
  customerId: z.uuid().optional(),
  currency: z.string().min(3).max(3).openapi({ example: "USD" }),
  subtotal: z.number().int().nonnegative().openapi({ example: 2500 }),
  taxTotal: z.number().int().nonnegative().openapi({ example: 200 }),
  shippingTotal: z.number().int().nonnegative().openapi({ example: 500 }),
  discountTotal: z.number().int().nonnegative().optional().openapi({ example: 0 }),
  grandTotal: z.number().int().nonnegative().openapi({ example: 3200 }),
  paymentIntentId: z.string().optional(),
  paymentMethodId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  lineItems: z.array(CreateOrderLineItemSchema).min(1),
}).openapi("CreateOrderRequest");

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

export const orderLookupRoute = createRoute({
  method: "get",
  path: "/lookup",
  tags: ["Orders"],
  summary: "Fuzzy order lookup (receipt-less return / support)",
  description: "Find orders by order number, customer email/name/phone, or walk-in label. Minimum query length is 3 characters.",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ example: "Perera" }),
      from: z.string().optional().openapi({ example: "2026-01-01" }),
      to: z.string().optional().openapi({ example: "2026-12-31" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.object({ items: z.array(z.record(z.string(), z.unknown())), hint: z.string().optional() }) }) } },
      description: "Lookup results",
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

export const createOrderRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Orders"],
  summary: "Create a draft / manual order",
  description: "Operator-created order (phone / POS / manual) with line items and totals, optionally without immediate payment.",
  request: {
    body: {
      content: { "application/json": { schema: CreateOrderBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Order created.",
    },
    ...errorResponses,
  },
});

export const refundOrderRoute = createRoute({
  method: "post",
  path: "/{id}/refund",
  tags: ["Orders"],
  summary: "Refund an order's payment",
  description: "Refunds the captured payment via the payment adapter and transitions the order to `refunded`. Omit `amount` for a full refund.",
  request: {
    params: OrderIdParam,
    body: {
      content: { "application/json": { schema: RefundOrderBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Order refunded.",
    },
    ...errorResponses,
  },
});

export const captureOrderRoute = createRoute({
  method: "post",
  path: "/{id}/capture",
  tags: ["Orders"],
  summary: "Capture an authorized payment",
  description: "Captures the authorized payment via the payment adapter and records `amountCaptured`. Omit `amount` for a full capture.",
  request: {
    params: OrderIdParam,
    body: {
      content: { "application/json": { schema: CaptureOrderBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Payment captured.",
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
