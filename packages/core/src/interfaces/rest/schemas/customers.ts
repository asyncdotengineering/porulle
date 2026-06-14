import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

export const CreateCustomerBodySchema = z.object({
  // Optional: omit for walk-in / POS customers who never log in. A synthetic
  // anonymous_<uuid> id is generated and metadata.walkIn is set.
  userId: z.string().optional().openapi({ example: "user_123" }),
  firstName: z.string().optional().openapi({ example: "Nimali" }),
  lastName: z.string().optional().openapi({ example: "Perera" }),
  phone: z.string().optional().openapi({ example: "+94 77 412 6601" }),
  email: z.string().optional().openapi({ example: "nimali@example.com" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateCustomerBody");

export const createCustomerRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Customers"],
  summary: "Create a customer (supports walk-in / userId-less)",
  request: {
    body: { content: { "application/json": { schema: CreateCustomerBodySchema } }, required: true },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
      description: "Customer created.",
    },
    ...errorResponses,
  },
});

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

// ─── Customer interactions (#3) ──────────────────────────────────────────────

export const InteractionKindEnum = z.enum([
  "visit", "call", "inquiry", "fitting", "follow_up", "message",
]);

export const CreateInteractionBodySchema = z.object({
  kind: InteractionKindEnum.openapi({ example: "visit" }),
  notes: z.string().min(1).openapi({ example: "Asked about the navy blazer in M." }),
  relatedEntityId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateInteractionBody");

export const UpdateInteractionBodySchema = CreateInteractionBodySchema.partial().openapi("UpdateInteractionBody");

const InteractionDataResponse = z.object({ data: z.record(z.string(), z.unknown()) });

export const listInteractionsRoute = createRoute({
  method: "get",
  path: "/{id}/interactions",
  tags: ["Customers"],
  summary: "List a customer's interactions",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }) } }, description: "Interactions" },
    ...errorResponses,
  },
});

export const createInteractionRoute = createRoute({
  method: "post",
  path: "/{id}/interactions",
  tags: ["Customers"],
  summary: "Log a customer interaction",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: CreateInteractionBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: InteractionDataResponse } }, description: "Interaction logged" },
    ...errorResponses,
  },
});

export const updateInteractionRoute = createRoute({
  method: "patch",
  path: "/{id}/interactions/{iid}",
  tags: ["Customers"],
  summary: "Edit a customer interaction",
  request: {
    params: z.object({ id: z.string().uuid(), iid: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateInteractionBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: InteractionDataResponse } }, description: "Interaction updated" },
    ...errorResponses,
  },
});

export const deleteInteractionRoute = createRoute({
  method: "delete",
  path: "/{id}/interactions/{iid}",
  tags: ["Customers"],
  summary: "Delete a customer interaction",
  request: { params: z.object({ id: z.string().uuid(), iid: z.string().uuid() }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ data: z.object({ deleted: z.literal(true) }) }) } }, description: "Deleted" },
    ...errorResponses,
  },
});
