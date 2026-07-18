import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses, UuidParamSchema } from "./shared.js";

// ─── Request Schemas ────────────────────────────────────────────────────────

import {
  CreatePromotionBodySchema,
  UpdatePromotionBodySchema as UpdatePromotionBodySchemaBase,
} from "../../../modules/promotions/schemas.js";
export { CreatePromotionBodySchema };

export const UpdatePromotionBodySchema = UpdatePromotionBodySchemaBase.openapi(
  "UpdatePromotionRequest",
);

export const ValidatePromotionBodySchema = z.object({
  code: z.string().openapi({ example: "SUMMER10" }),
  currency: z.string().length(3).openapi({ example: "USD" }),
  subtotal: z.number().openapi({ example: 100 }),
  lineItems: z.array(z.object({
    entityId: z.string(),
    entityType: z.string(),
    quantity: z.number().int(),
    unitPrice: z.number(),
    totalPrice: z.number(),
  })),
  customerId: z.string().optional(),
  customerGroupIds: z.array(z.string()).optional(),
}).openapi("ValidatePromotionRequest");

// ─── Response Schemas ───────────────────────────────────────────────────────

export const PromotionResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()),
}).openapi("PromotionResponse");

// The authoritative result of applying a code to a cart — the SAME computation
// checkout uses, so a storefront can show the exact discount the order will get
// (no client-side re-derivation, which would drift from checkout).
export const PromotionValidationResultSchema = z.object({
  data: z.object({
    totalDiscount: z.number().openapi({
      example: 1000,
      description: "Discount this code applies to the cart, in the cart's minor units (e.g. cents).",
    }),
    freeShipping: z.boolean().openapi({ example: false }),
    applied: z.array(z.object({
      promotionId: z.string(),
      code: z.string().optional(),
      type: z.string(),
      discountAmount: z.number(),
      freeShipping: z.boolean(),
      description: z.string(),
    })).openapi({ description: "The promotion(s) applied by this code." }),
    rejectedCodes: z.array(z.object({
      code: z.string(),
      reason: z.string(),
    })),
  }),
}).openapi("PromotionValidationResult");

// ─── Path Params ────────────────────────────────────────────────────────────

const PromotionIdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

// ─── Route Definitions ──────────────────────────────────────────────────────

export const listPromotionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Promotions"],
  summary: "List promotions",
  description: "Lists promotions. Filter by status: active (currently valid), inactive (deactivated), expired (past validUntil), scheduled (future validFrom). Omit status to return all.",
  request: {
    query: z.object({
      status: z.enum(["active", "inactive", "expired", "scheduled"]).optional().openapi({ example: "active" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }) } },
      description: "Promotions list",
    },
  },
});

export const createPromotionRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Promotions"],
  summary: "Create a new promotion",
  request: {
    body: {
      content: {
        "application/json": { schema: CreatePromotionBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: PromotionResponseSchema } },
      description: "Promotion created successfully.",
    },
    ...errorResponses,
  },
});

export const validatePromotionRoute = createRoute({
  method: "post",
  path: "/validate",
  tags: ["Promotions"],
  summary: "Validate a promotion code against a cart",
  request: {
    body: {
      content: {
        "application/json": { schema: ValidatePromotionBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PromotionValidationResultSchema } },
      description: "The code is valid for this cart: the authoritative discount it applies (same computation as checkout).",
    },
    ...errorResponses,
  },
});

export const updatePromotionRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Promotions"],
  summary: "Edit a promotion",
  description: "Update any subset of a promotion's fields (name, code, type, value, validity dates, scope, metadata, isActive). Validated the same way create is.",
  request: {
    params: PromotionIdParam,
    body: {
      content: {
        "application/json": { schema: UpdatePromotionBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PromotionResponseSchema } },
      description: "Promotion updated.",
    },
    ...errorResponses,
  },
});

export const deactivatePromotionRoute = createRoute({
  method: "post",
  path: "/{id}/deactivate",
  tags: ["Promotions"],
  summary: "Deactivate a promotion",
  request: {
    params: PromotionIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PromotionResponseSchema } },
      description: "Promotion deactivated.",
    },
    ...errorResponses,
  },
});
