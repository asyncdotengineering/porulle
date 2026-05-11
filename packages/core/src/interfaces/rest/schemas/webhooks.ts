import { z, createRoute } from "@hono/zod-openapi";
import { ErrorSchema, errorResponses } from "./shared.js";

// ─── Request Schema ──────────────────────────────────────────────────────────

export const CreateWebhookEndpointBodySchema = z.object({
  url: z.string().url().openapi({ example: "https://example.com/webhooks" }),
  events: z.array(z.string()).openapi({ example: ["order.created", "order.fulfilled"] }),
  secret: z.string().optional().openapi({ example: "whsec_abc123" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateWebhookEndpointRequest");

// ─── Route Definitions ──────────────────────────────────────────────────────

export const listWebhookEndpointsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Webhooks"],
  summary: "List webhook endpoints",
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.array(z.record(z.string(), z.unknown())) }) } },
      description: "Webhook endpoints",
    },
  },
});

export const deleteWebhookEndpointRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["Webhooks"],
  summary: "Delete a webhook endpoint",
  request: {
    params: z.object({
      id: z.uuid().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ data: z.object({ deleted: z.literal(true) }) }) } },
      description: "Webhook endpoint deleted.",
    },
    ...errorResponses,
  },
});

export const createWebhookEndpointRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Webhooks"],
  summary: "Create a webhook endpoint",
  description: "Registers a new webhook endpoint that will receive event notifications.",
  request: {
    body: {
      content: {
        "application/json": { schema: CreateWebhookEndpointBodySchema },
      },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: z.object({ data: z.record(z.string(), z.unknown()) }) } },
      description: "Webhook endpoint created.",
    },
    ...errorResponses,
  },
});
