import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

export const CreateTaxRateBodySchema = z.object({
  name: z.string().min(1).openapi({ example: "NY sales tax" }),
  country: z.string().min(1).openapi({ example: "US", description: "ISO 3166-1 alpha-2; \"*\" matches any country" }),
  state: z.string().min(1).optional().openapi({ example: "NY" }),
  rateBps: z.number().int().nonnegative().openapi({ example: 500, description: "Basis points: 500 = 5%" }),
  appliesToShipping: z.boolean().optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
}).openapi("CreateTaxRateRequest");

export const UpdateTaxRateBodySchema = z.object({
  name: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  state: z.string().min(1).nullable().optional(),
  rateBps: z.number().int().nonnegative().optional(),
  appliesToShipping: z.boolean().optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
}).openapi("UpdateTaxRateRequest");

const IdParam = z.object({
  id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
});

const DataResponse = z.object({ data: z.any() }).openapi("TaxConfigResponse");

export const createTaxRateRoute = createRoute({
  method: "post",
  path: "/rates",
  tags: ["Tax"],
  summary: "Create a tax rate",
  request: {
    body: { content: { "application/json": { schema: CreateTaxRateBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Tax rate created." },
    ...errorResponses,
  },
});

export const listTaxRatesRoute = createRoute({
  method: "get",
  path: "/rates",
  tags: ["Tax"],
  summary: "List tax rates",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Tax rates" },
    ...errorResponses,
  },
});

export const updateTaxRateRoute = createRoute({
  method: "patch",
  path: "/rates/{id}",
  tags: ["Tax"],
  summary: "Update a tax rate",
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateTaxRateBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Tax rate updated." },
    ...errorResponses,
  },
});

export const deleteTaxRateRoute = createRoute({
  method: "delete",
  path: "/rates/{id}",
  tags: ["Tax"],
  summary: "Delete a tax rate",
  request: { params: IdParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Tax rate deleted." },
    ...errorResponses,
  },
});
