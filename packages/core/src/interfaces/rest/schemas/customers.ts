import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

export const listCustomersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Customers"],
  summary: "List customers",
  request: {
    query: z.object({
      page: z.string().optional().openapi({ example: "1" }),
      limit: z.string().optional().openapi({ example: "20" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(z.record(z.string(), z.unknown())),
            meta: z.object({
              pagination: z.object({
                page: z.number(),
                limit: z.number(),
                total: z.number(),
                totalPages: z.number(),
              }),
            }),
          }),
        },
      },
      description: "Customer list",
    },
  },
});

export const getCustomerRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Customers"],
  summary: "Get customer by ID",
  request: {
    params: z.object({
      id: z.string().uuid().openapi({ example: "b482a588-..." }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.record(z.string(), z.unknown()) }),
        },
      },
      description: "Customer detail",
    },
    ...errorResponses,
  },
});

export const updateCustomerRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["Customers"],
  summary: "Update a customer",
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            email: z.string().email().optional(),
            phone: z.string().optional(),
            metadata: z.record(z.string(), z.unknown()).optional(),
          }).openapi("UpdateCustomerRequest"),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.record(z.string(), z.unknown()) }),
        },
      },
      description: "Customer updated",
    },
    ...errorResponses,
  },
});

export const getCustomerOrdersRoute = createRoute({
  method: "get",
  path: "/{id}/orders",
  tags: ["Customers"],
  summary: "List orders for a customer",
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    query: z.object({
      status: z.string().optional(),
      page: z.string().optional().openapi({ example: "1" }),
      limit: z.string().optional().openapi({ example: "20" }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(z.record(z.string(), z.unknown())),
            meta: z.object({
              pagination: z.object({
                page: z.number(),
                limit: z.number(),
                total: z.number(),
                totalPages: z.number(),
              }),
            }),
          }),
        },
      },
      description: "Customer orders",
    },
    ...errorResponses,
  },
});

export const getCustomerAddressesRoute = createRoute({
  method: "get",
  path: "/{id}/addresses",
  tags: ["Customers"],
  summary: "List addresses for a customer",
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }),
        },
      },
      description: "Customer addresses",
    },
    ...errorResponses,
  },
});
