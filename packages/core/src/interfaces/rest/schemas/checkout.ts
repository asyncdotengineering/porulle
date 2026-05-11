import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses } from "./shared.js";

// ─── Request Schema ──────────────────────────────────────────────────────────

export const CheckoutBodySchema = z.object({
  cartId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
  paymentMethodId: z.string().openapi({ example: "pm_card_visa" }),
  customerId: z.string().optional().openapi({ example: "customer-uuid-or-user-id" }),
  customerGroupIds: z.array(z.string()).optional(),
  currency: z.string().length(3).optional().openapi({ example: "USD" }),
  promotionCodes: z.array(z.string()).optional().openapi({ example: ["SUMMER10"] }),
  shippingAddress: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    state: z.string().optional(),
    postalCode: z.string(),
    country: z.string(),
  }).optional(),
}).openapi("CheckoutRequest");

// ─── Response Schema ─────────────────────────────────────────────────────────

export const OrderResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    orderNumber: z.string(),
    status: z.string(),
    currency: z.string(),
    subtotal: z.number(),
    taxTotal: z.number(),
    shippingTotal: z.number(),
    discountTotal: z.number(),
    grandTotal: z.number(),
    placedAt: z.string(),
  }),
  meta: z.object({
    hookErrors: z.array(z.string()),
  }).optional(),
}).openapi("CheckoutResponse");

// ─── Route Definition ────────────────────────────────────────────────────────

export const checkoutRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Checkout"],
  summary: "Process checkout and create an order",
  description: "Validates cart, reserves inventory, authorizes payment, calculates tax/shipping, and creates the order.",
  request: {
    body: {
      content: {
        "application/json": { schema: CheckoutBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: OrderResponseSchema } },
      description: "Order created successfully.",
    },
    ...errorResponses,
  },
});
