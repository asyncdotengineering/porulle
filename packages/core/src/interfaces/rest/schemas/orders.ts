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
  idempotencyKey: z.string().min(8).max(255).optional().openapi({
    example: "pos-sale-8f14e45f-1738312200",
    description: "Client-supplied retry key. Re-submitting a create with the same key returns the original order instead of creating a duplicate (safe offline-queue replay).",
  }),
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

export const CreateFulfillmentBodySchema = z.object({
  lineItems: z.array(z.object({
    orderLineItemId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    quantity: z.number().int().positive().openapi({ example: 2 }),
  })).min(1),
  carrier: z.string().optional().openapi({ example: "DHL" }),
  trackingNumber: z.string().optional().openapi({ example: "DHL-123456" }),
  trackingUrl: z.string().optional().openapi({ example: "https://track.dhl.com/DHL-123456" }),
  type: z.string().optional().openapi({ example: "physical" }),
  status: z.string().optional().openapi({ example: "shipped" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateFulfillmentRequest");

export const createOrderFulfillmentRoute = createRoute({
  method: "post",
  path: "/{id}/fulfillments",
  tags: ["Orders"],
  summary: "Record a fulfillment (shipment) for an order",
  description: "Creates a fulfillment for a subset of the order's line items with optional carrier/tracking details. Supports partial fulfillment (per-line quantities) and multiple fulfillments per order.",
  request: {
    params: OrderIdParam,
    body: {
      content: { "application/json": { schema: CreateFulfillmentBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Fulfillment recorded.",
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

export const AddOrderLineItemBodySchema = z.object({
  entityId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  entityType: z.string().min(1).openapi({ example: "product" }),
  variantId: z.uuid().optional(),
  sku: z.string().optional(),
  title: z.string().min(1).openapi({ example: "Ceylon Black Tea 250g" }),
  quantity: z.number().int().positive().openapi({ example: 1 }),
  unitPrice: z.number().int().nonnegative().openapi({ example: 1250 }),
  totalPrice: z.number().int().nonnegative().optional().openapi({ example: 1250 }),
  taxAmount: z.number().int().nonnegative().optional(),
  discountAmount: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("AddOrderLineItemRequest");

export const UpdateOrderLineItemBodySchema = z.object({
  quantity: z.number().int().positive().openapi({ example: 3 }),
}).openapi("UpdateOrderLineItemRequest");

const OrderLineItemParams = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  lineItemId: z.uuid().openapi({ example: "660e8400-e29b-41d4-a716-446655440001" }),
});

export const addOrderLineItemRoute = createRoute({
  method: "post",
  path: "/{id}/line-items",
  tags: ["Orders"],
  summary: "Add a line item to a placed order",
  description: "Adds a line item to a non-terminal order and recalculates subtotal/tax/grand totals. Records an audit entry.",
  request: {
    params: OrderIdParam,
    body: {
      content: { "application/json": { schema: AddOrderLineItemBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Line item added; updated order returned.",
    },
    ...errorResponses,
  },
});

export const updateOrderLineItemRoute = createRoute({
  method: "patch",
  path: "/{id}/line-items/{lineItemId}",
  tags: ["Orders"],
  summary: "Adjust a line item's quantity on a placed order",
  description: "Changes a line item's quantity on a non-terminal order, scaling line totals/tax and recalculating order totals. Records an audit entry.",
  request: {
    params: OrderLineItemParams,
    body: {
      content: { "application/json": { schema: UpdateOrderLineItemBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Line item updated; updated order returned.",
    },
    ...errorResponses,
  },
});

export const removeOrderLineItemRoute = createRoute({
  method: "delete",
  path: "/{id}/line-items/{lineItemId}",
  tags: ["Orders"],
  summary: "Remove a line item from a placed order",
  description: "Removes a line item from a non-terminal order (at least one line item must remain) and recalculates order totals. Records an audit entry.",
  request: {
    params: OrderLineItemParams,
  },
  responses: {
    200: {
      content: { "application/json": { schema: OrderDataResponseSchema } },
      description: "Line item removed; updated order returned.",
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

// ── Line-level refund policy primitives (issue #52) ─────────────────────────

export const RefundLinesBodySchema = z.object({
  lines: z.array(z.object({
    lineItemId: z.uuid(),
    quantity: z.number().int().min(1),
  })).min(1),
  reason: z.string().max(500).optional(),
}).openapi("RefundLinesRequest");

const RefundParam = z.object({
  id: z.uuid(),
  refundId: z.uuid(),
});

const RefundDataResponse = z.object({ data: z.any() }).openapi("RefundResponse");

export const refundOrderLinesRoute = createRoute({
  method: "post",
  path: "/{id}/refunds",
  tags: ["Orders"],
  summary: "Refund specific line-item quantities",
  description: "Enforces per-line refundable quantity and the operator's daily refund cap (policies.refundDailyCap). Records an auditable refund ledger row supporting undo.",
  request: {
    params: OrderIdParam,
    body: { content: { "application/json": { schema: RefundLinesBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: RefundDataResponse } }, description: "Refund recorded." },
    ...errorResponses,
  },
});

export const undoOrderRefundRoute = createRoute({
  method: "post",
  path: "/{id}/refunds/{refundId}/undo",
  tags: ["Orders"],
  summary: "Undo a refund within the policy window",
  request: { params: RefundParam },
  responses: {
    200: { content: { "application/json": { schema: RefundDataResponse } }, description: "Refund undone." },
    ...errorResponses,
  },
});

export const listOrderRefundsRoute = createRoute({
  method: "get",
  path: "/{id}/refunds",
  tags: ["Orders"],
  summary: "List an order's refunds",
  request: { params: OrderIdParam },
  responses: {
    200: { content: { "application/json": { schema: RefundDataResponse } }, description: "Refund ledger rows." },
    ...errorResponses,
  },
});

export const refundCapStatusRoute = createRoute({
  method: "get",
  path: "/refunds/cap",
  tags: ["Orders"],
  summary: "The acting operator's daily refund-cap status",
  responses: {
    200: { content: { "application/json": { schema: RefundDataResponse } }, description: "Cap, used-today, and remaining." },
    ...errorResponses,
  },
});

// ── Order notes + activity timeline (issue #56) ─────────────────────────────

export const CreateOrderNoteBodySchema = z.object({
  body: z.string().min(1).max(2000),
  pinned: z.boolean().optional(),
}).openapi("CreateOrderNoteRequest");

const NoteParam = z.object({
  id: z.uuid(),
  noteId: z.uuid(),
});

const NoteDataResponse = z.object({ data: z.any() }).openapi("OrderNoteResponse");

export const createOrderNoteRoute = createRoute({
  method: "post",
  path: "/{id}/notes",
  tags: ["Orders"],
  summary: "Add an operator note to an order",
  request: {
    params: OrderIdParam,
    body: { content: { "application/json": { schema: CreateOrderNoteBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: NoteDataResponse } }, description: "Note created." },
    ...errorResponses,
  },
});

export const listOrderNotesRoute = createRoute({
  method: "get",
  path: "/{id}/notes",
  tags: ["Orders"],
  summary: "List an order's notes (pinned first)",
  request: { params: OrderIdParam },
  responses: {
    200: { content: { "application/json": { schema: NoteDataResponse } }, description: "Notes." },
    ...errorResponses,
  },
});

export const deleteOrderNoteRoute = createRoute({
  method: "delete",
  path: "/{id}/notes/{noteId}",
  tags: ["Orders"],
  summary: "Delete an order note",
  request: { params: NoteParam },
  responses: {
    200: { content: { "application/json": { schema: NoteDataResponse } }, description: "Note deleted." },
    ...errorResponses,
  },
});

export const orderTimelineRoute = createRoute({
  method: "get",
  path: "/{id}/timeline",
  tags: ["Orders"],
  summary: "Merged activity timeline: status changes + notes + refunds, newest first",
  request: { params: OrderIdParam },
  responses: {
    200: { content: { "application/json": { schema: NoteDataResponse } }, description: "Timeline events." },
    ...errorResponses,
  },
});
