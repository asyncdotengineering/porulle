/**
 * Typed response schemas derived from Drizzle table definitions.
 *
 * Uses drizzle-zod's createSelectSchema() to generate Zod schemas that
 * match the exact database column types. These replace z.any() in route
 * response definitions, making the OpenAPI spec show real field names
 * and types instead of empty {}.
 */

import { createSelectSchema } from "drizzle-zod";
import { z } from "@hono/zod-openapi";
import { orders, orderLineItems } from "../../../modules/orders/schema.js";
import { carts, cartLineItems } from "../../../modules/cart/schema.js";
import { customers, customerAddresses } from "../../../modules/customers/schema.js";
import { sellableEntities } from "../../../modules/catalog/schema.js";
import { commerceJobs } from "../../../kernel/jobs/schema.js";

// ─── Orders ──────────────────────────────────────────────────────────────────

export const OrderSchema = createSelectSchema(orders, {
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("Order");

export const OrderLineItemSchema = createSelectSchema(orderLineItems, {
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("OrderLineItem");

export const OrderWithItemsSchema = z.object({
  ...OrderSchema.shape,
  lineItems: z.array(OrderLineItemSchema).optional(),
}).openapi("OrderWithItems");

// ─── Carts ───────────────────────────────────────────────────────────────────

export const CartSchema = createSelectSchema(carts, {
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("Cart");

export const CartLineItemSchema = createSelectSchema(cartLineItems, {
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CartLineItem");

export const CartWithItemsSchema = z.object({
  ...CartSchema.shape,
  lineItems: z.array(CartLineItemSchema).optional(),
}).openapi("CartWithItems");

// ─── Customers ───────────────────────────────────────────────────────────────

export const CustomerSchema = createSelectSchema(customers).openapi("Customer");

export const CustomerAddressSchema = createSelectSchema(customerAddresses).openapi("CustomerAddress");

// ─── Catalog ─────────────────────────────────────────────────────────────────

export const CatalogEntitySchema = createSelectSchema(sellableEntities, {
  // Override jsonb → narrow to object (drizzle-zod maps jsonb to a wide union)
  metadata: z.record(z.string(), z.unknown()).openapi({ example: { weight: 200, material: "cotton" } }),
}).openapi("CatalogEntity");

// ─── Jobs ────────────────────────────────────────────────────────────────────

export const JobSchema = createSelectSchema(commerceJobs).openapi("Job");

// ─── Wrapped Response Helpers ────────────────────────────────────────────────
// These wrap a schema in { data: T } for consistent API response format.

export function dataResponse<T extends z.ZodType>(schema: T, name: string) {
  return z.object({ data: schema }).openapi(name);
}

export function dataArrayResponse<T extends z.ZodType>(schema: T, name: string) {
  return z.object({ data: z.array(schema) }).openapi(name);
}

export function paginatedResponse<T extends z.ZodType>(schema: T, name: string) {
  return z.object({
    data: z.array(schema),
    meta: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number().optional(),
    }).optional(),
  }).openapi(name);
}

// ─── Pre-built Response Schemas ──────────────────────────────────────────────

export const OrderResponse = dataResponse(OrderSchema, "OrderResponse");
export const OrderListResponse = paginatedResponse(OrderSchema, "OrderListResponse");
export const CartResponse = dataResponse(CartWithItemsSchema, "CartResponse");
export const CustomerResponse = dataResponse(CustomerSchema, "CustomerResponse");
export const CustomerAddressListResponse = dataArrayResponse(CustomerAddressSchema, "CustomerAddressListResponse");
export const CatalogEntityResponse = dataResponse(CatalogEntitySchema, "CatalogEntityResponse");
export const CatalogEntityListResponse = paginatedResponse(CatalogEntitySchema, "CatalogEntityListResponse");
export const JobListResponse = dataArrayResponse(JobSchema, "JobListResponse");
