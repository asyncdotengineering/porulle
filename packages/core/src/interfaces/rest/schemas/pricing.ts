import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses } from "./shared.js";

// ─── Request Schemas ────────────────────────────────────────────────────────

import { SetBasePriceBodySchema, CreateModifierBodySchema } from "../../../modules/pricing/schemas.js";
export { SetBasePriceBodySchema, CreateModifierBodySchema };

// ─── Response Schemas ───────────────────────────────────────────────────────

export const PricingResponseSchema = z.object({
  data: z.record(z.string(), z.unknown()),
}).openapi("PricingResponse");

// ─── Route Definitions ──────────────────────────────────────────────────────

export const listPricesRoute = createRoute({
  method: "get",
  path: "/prices",
  tags: ["Pricing"],
  summary: "List prices",
  request: {
    query: z.object({
      entityId: z.string().optional(),
      variantId: z.string().optional(),
      currency: z.string().optional(),
      customerGroupId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: PricingResponseSchema } },
      description: "Prices",
    },
  },
});

export const setBasePriceRoute = createRoute({
  method: "post",
  path: "/prices",
  tags: ["Pricing"],
  summary: "Set a base price for a product or variant",
  request: {
    body: {
      content: {
        "application/json": { schema: SetBasePriceBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: PricingResponseSchema } },
      description: "Base price set successfully.",
    },
    ...errorResponses,
  },
});

export const UpdateModifierBodySchema = z.object({
  name: z.string().optional(),
  value: z.number().optional(),
  priority: z.number().int().optional(),
  validFrom: z.coerce.date().nullable().optional(),
  validUntil: z.coerce.date().nullable().optional(),
  minQuantity: z.number().int().nullable().optional(),
  maxQuantity: z.number().int().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateModifierRequest");

const ModifierIdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

export const listModifiersRoute = createRoute({
  method: "get",
  path: "/modifiers",
  tags: ["Pricing"],
  summary: "List price modifiers",
  description: "Lists active and scheduled price modifiers. Filter by entityId, currency, or active=true (currently within validity window).",
  request: {
    query: z.object({
      entityId: z.string().optional(),
      currency: z.string().optional(),
      active: z.string().optional().openapi({ example: "true" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: PricingResponseSchema } },
      description: "Price modifiers",
    },
    ...errorResponses,
  },
});

export const updateModifierRoute = createRoute({
  method: "patch",
  path: "/modifiers/{id}",
  tags: ["Pricing"],
  summary: "Update a price modifier's value or validity",
  request: {
    params: ModifierIdParam,
    body: {
      content: { "application/json": { schema: UpdateModifierBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: PricingResponseSchema } },
      description: "Price modifier updated.",
    },
    ...errorResponses,
  },
});

export const deleteModifierRoute = createRoute({
  method: "delete",
  path: "/modifiers/{id}",
  tags: ["Pricing"],
  summary: "Delete a price modifier (end a sale early)",
  request: {
    params: ModifierIdParam,
  },
  responses: {
    200: {
      content: { "application/json": { schema: PricingResponseSchema } },
      description: "Price modifier deleted.",
    },
    ...errorResponses,
  },
});

export const createModifierRoute = createRoute({
  method: "post",
  path: "/modifiers",
  tags: ["Pricing"],
  summary: "Create a price modifier",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateModifierBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: PricingResponseSchema } },
      description: "Price modifier created successfully.",
    },
    ...errorResponses,
  },
});
