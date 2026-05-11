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
