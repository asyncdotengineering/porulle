import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";
import { CustomerResponse, OrderResponse, OrderListResponse, CustomerAddressListResponse, CartResponse } from "./responses.js";

const GenericDataResponse = z.object({ data: z.record(z.string(), z.unknown()) });

// ─── GET Route Definitions ─────────────────────────────────────────────────

export const getProfileRoute = createRoute({
  method: "get",
  path: "/profile",
  tags: ["Customer Portal"],
  summary: "Get customer profile",
  responses: {
    200: { content: { "application/json": { schema: CustomerResponse } }, description: "Customer profile" },
    ...errorResponses,
  },
});

export const listAddressesRoute = createRoute({
  method: "get",
  path: "/addresses",
  tags: ["Customer Portal"],
  summary: "List customer addresses",
  responses: {
    200: { content: { "application/json": { schema: CustomerAddressListResponse } }, description: "Addresses" },
  },
});

export const listCustomerOrdersRoute = createRoute({
  method: "get",
  path: "/orders",
  tags: ["Customer Portal"],
  summary: "List customer orders",
  request: {
    query: z.object({
      status: z.string().optional(),
      page: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: OrderListResponse } }, description: "Orders" },
  },
});

export const getCustomerOrderRoute = createRoute({
  method: "get",
  path: "/orders/{idOrNumber}",
  tags: ["Customer Portal"],
  summary: "Get a specific customer order",
  request: {
    params: z.object({
      idOrNumber: z.string().min(1).openapi({ example: "ORD-001" }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: OrderResponse } }, description: "Order details" },
    ...errorResponses,
  },
});

export const getOrderTrackingRoute = createRoute({
  method: "get",
  path: "/orders/{idOrNumber}/tracking",
  tags: ["Customer Portal"],
  summary: "Get tracking info for an order",
  request: {
    params: z.object({
      idOrNumber: z.string().min(1).openapi({ example: "ORD-001" }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: GenericDataResponse } }, description: "Tracking info" },
    ...errorResponses,
  },
});

export const getOrderDownloadsRoute = createRoute({
  method: "get",
  path: "/orders/{orderId}/downloads",
  tags: ["Customer Portal"],
  summary: "Get digital downloads for an order",
  request: {
    params: z.object({
      orderId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: GenericDataResponse } }, description: "Downloads" },
    ...errorResponses,
  },
});

export const listCoursesRoute = createRoute({
  method: "get",
  path: "/courses",
  tags: ["Customer Portal"],
  summary: "List customer course access",
  responses: {
    200: { content: { "application/json": { schema: GenericDataResponse } }, description: "Courses" },
  },
});

// ─── DELETE Route Definitions ──────────────────────────────────────────────

export const deleteAddressRoute = createRoute({
  method: "delete",
  path: "/addresses/{id}",
  tags: ["Customer Portal"],
  summary: "Delete a customer address",
  request: {
    params: z.object({
      id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ deleted: z.literal(true) }) }) } }, description: "Deleted" },
    ...errorResponses,
  },
});

// ─── POST Route Definitions (no body or special) ───────────────────────────

export const reorderRoute = createRoute({
  method: "post",
  path: "/orders/{orderId}/reorder",
  tags: ["Customer Portal"],
  summary: "Reorder items from a previous order",
  request: {
    params: z.object({
      orderId: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    201: { content: { "application/json": { schema: CartResponse } }, description: "Reorder cart created" },
    ...errorResponses,
  },
});

// ─── Mutation Route Definitions ─────────────────────────────────────────────

const UpdateProfileBodySchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateProfileBody");

const CreateAddressBodySchema = z.object({
  type: z.enum(["shipping", "billing"]).openapi({ example: "shipping" }),
  firstName: z.string().openapi({ example: "John" }),
  lastName: z.string().openapi({ example: "Doe" }),
  line1: z.string().openapi({ example: "123 Main St" }),
  line2: z.string().optional(),
  city: z.string().openapi({ example: "New York" }),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().openapi({ example: "US" }),
  phone: z.string().optional(),
}).openapi("CreateAddressBody");

export const updateProfileRoute = createRoute({
  method: "patch",
  path: "/profile",
  tags: ["Customer Portal"],
  summary: "Update customer profile",
  request: {
    body: {
      content: { "application/json": { schema: UpdateProfileBodySchema } },
      required: true,
    },
  },
  responses: {
    200: { content: { "application/json": { schema: CustomerResponse } }, description: "Updated" },
    ...errorResponses,
  },
});

export const createAddressRoute = createRoute({
  method: "post",
  path: "/addresses",
  tags: ["Customer Portal"],
  summary: "Create a customer address",
  request: {
    body: {
      content: { "application/json": { schema: CreateAddressBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { content: { "application/json": { schema: GenericDataResponse } }, description: "Created" },
    ...errorResponses,
  },
});
