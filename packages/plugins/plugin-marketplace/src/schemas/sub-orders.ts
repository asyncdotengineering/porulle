import { z } from "@hono/zod-openapi";

// ─── Update Sub-Order Status ─────────────────────────────────────────────────

export const UpdateSubOrderStatusBodySchema = z.object({
  status: z.enum(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"])
    .openapi({ example: "processing" }),
  reason: z.string().optional().openapi({ example: "Admin force status change" }),
}).openapi("UpdateSubOrderStatusRequest");

// ─── List Sub-Orders ────────────────────────────────────────────────────────

// ─── Get Sub-Order ──────────────────────────────────────────────────────────
