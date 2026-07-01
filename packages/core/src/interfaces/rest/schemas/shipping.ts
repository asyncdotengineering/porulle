import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

// ─── Request Schemas ────────────────────────────────────────────────────────

export const CreateShippingZoneBodySchema = z.object({
  name: z.string().min(1).openapi({ example: "United States" }),
  countries: z.array(z.string().min(1)).min(1).openapi({ example: ["US"] }),
  states: z.array(z.string().min(1)).optional().openapi({ example: ["NY", "NJ"] }),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
}).openapi("CreateShippingZoneRequest");

export const UpdateShippingZoneBodySchema = z.object({
  name: z.string().min(1).optional(),
  countries: z.array(z.string().min(1)).min(1).optional(),
  states: z.array(z.string().min(1)).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
}).openapi("UpdateShippingZoneRequest");

export const CreateShippingRateBodySchema = z.object({
  zoneId: z.uuid(),
  name: z.string().min(1).openapi({ example: "Standard" }),
  amount: z.number().int().nonnegative().openapi({ example: 1500, description: "Flat cost in minor units" }),
  currency: z.string().length(3).optional().openapi({ example: "USD" }),
  minSubtotal: z.number().int().nonnegative().optional(),
  maxSubtotal: z.number().int().nonnegative().optional(),
  minWeightGrams: z.number().int().nonnegative().optional(),
  maxWeightGrams: z.number().int().nonnegative().optional(),
  freeShippingThreshold: z.number().int().nonnegative().optional().openapi({ example: 10000, description: "Subtotal at or above which shipping is free" }),
  isActive: z.boolean().optional(),
}).openapi("CreateShippingRateRequest");

export const UpdateShippingRateBodySchema = z.object({
  name: z.string().min(1).optional(),
  amount: z.number().int().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  minSubtotal: z.number().int().nonnegative().nullable().optional(),
  maxSubtotal: z.number().int().nonnegative().nullable().optional(),
  minWeightGrams: z.number().int().nonnegative().nullable().optional(),
  maxWeightGrams: z.number().int().nonnegative().nullable().optional(),
  freeShippingThreshold: z.number().int().nonnegative().nullable().optional(),
  isActive: z.boolean().optional(),
}).openapi("UpdateShippingRateRequest");

// ─── Shared ─────────────────────────────────────────────────────────────────

const IdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

const DataResponse = z.object({ data: z.any() }).openapi("ShippingConfigResponse");

// ─── Zone Routes ────────────────────────────────────────────────────────────

export const createShippingZoneRoute = createRoute({
  method: "post",
  path: "/zones",
  tags: ["Shipping"],
  summary: "Create a shipping zone",
  request: {
    body: { content: { "application/json": { schema: CreateShippingZoneBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Zone created." },
    ...errorResponses,
  },
});

export const listShippingZonesRoute = createRoute({
  method: "get",
  path: "/zones",
  tags: ["Shipping"],
  summary: "List shipping zones",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Zones" },
    ...errorResponses,
  },
});

export const updateShippingZoneRoute = createRoute({
  method: "patch",
  path: "/zones/{id}",
  tags: ["Shipping"],
  summary: "Update a shipping zone",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateShippingZoneBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Zone updated." },
    ...errorResponses,
  },
});

export const deleteShippingZoneRoute = createRoute({
  method: "delete",
  path: "/zones/{id}",
  tags: ["Shipping"],
  summary: "Delete a shipping zone (and its rates)",
  request: { params: IdParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Zone deleted." },
    ...errorResponses,
  },
});

// ─── Rate Routes ────────────────────────────────────────────────────────────

export const createShippingRateRoute = createRoute({
  method: "post",
  path: "/rates",
  tags: ["Shipping"],
  summary: "Create a shipping rate in a zone",
  request: {
    body: { content: { "application/json": { schema: CreateShippingRateBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Rate created." },
    ...errorResponses,
  },
});

export const listShippingRatesRoute = createRoute({
  method: "get",
  path: "/rates",
  tags: ["Shipping"],
  summary: "List shipping rates",
  request: {
    query: z.object({ zoneId: z.string().optional() }),
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Rates" },
    ...errorResponses,
  },
});

export const updateShippingRateRoute = createRoute({
  method: "patch",
  path: "/rates/{id}",
  tags: ["Shipping"],
  summary: "Update a shipping rate",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateShippingRateBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Rate updated." },
    ...errorResponses,
  },
});

export const deleteShippingRateRoute = createRoute({
  method: "delete",
  path: "/rates/{id}",
  tags: ["Shipping"],
  summary: "Delete a shipping rate",
  request: { params: IdParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Rate deleted." },
    ...errorResponses,
  },
});
