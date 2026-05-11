import { z, createRoute } from "@hono/zod-openapi";

const ErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const errorResponses = {
  401: { content: { "application/json": { schema: ErrorSchema } }, description: "Authentication required." },
  403: { content: { "application/json": { schema: ErrorSchema } }, description: "Insufficient permissions." },
  404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found." },
  422: { content: { "application/json": { schema: ErrorSchema } }, description: "Validation error." },
  500: { content: { "application/json": { schema: ErrorSchema } }, description: "Server error." },
} as const;

const PayoutResponseSchema = z.object({ data: z.any() });

// ─── Run Payout Cycle ────────────────────────────────────────────────────────

export const RunPayoutCycleBodySchema = z.object({
  vendorIds: z.array(z.uuid()).optional().openapi({ description: "Limit payout run to specific vendors" }),
  force: z.boolean().optional().openapi({ description: "Force payout even if below minimum threshold" }),
}).openapi("RunPayoutCycleRequest");

export const runPayoutCycleRoute = createRoute({
  method: "post",
  path: "/api/marketplace/payouts/run",
  tags: ["Marketplace - Payouts"],
  summary: "Run a payout cycle",
  request: {
    body: { content: { "application/json": { schema: RunPayoutCycleBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: PayoutResponseSchema } }, description: "Payout cycle completed." },
    ...errorResponses,
  },
});

// ─── List Payouts ───────────────────────────────────────────────────────────

export const listPayoutsRoute = createRoute({
  method: "get",
  path: "/api/marketplace/payouts",
  tags: ["Marketplace - Payouts"],
  summary: "List payouts",
  request: {
    query: z.object({
      vendorId: z.string().optional(),
      status: z.string().optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: PayoutResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});

// ─── Retry Payout ───────────────────────────────────────────────────────────

export const retryPayoutRoute = createRoute({
  method: "post",
  path: "/api/marketplace/payouts/{id}/retry",
  tags: ["Marketplace - Payouts"],
  summary: "Retry a failed payout",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: PayoutResponseSchema } }, description: "Payout retried." },
    ...errorResponses,
  },
});

// ─── Get Payout ─────────────────────────────────────────────────────────────

export const getPayoutRoute = createRoute({
  method: "get",
  path: "/api/marketplace/payouts/{id}",
  tags: ["Marketplace - Payouts"],
  summary: "Get payout by ID",
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: { content: { "application/json": { schema: PayoutResponseSchema } }, description: "Success" },
    ...errorResponses,
  },
});
