import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { GiftCardService } from "../services/gift-card-service.js";
import type { PluginRouteRegistration } from "@porulle/core";
import { formatCode } from "../code-generator.js";

export function buildAdminRoutes(
  service: GiftCardService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Gift Cards (Admin)", "/gift-cards", ctx);

  // ─── Create Gift Card ─────────────────────────────────────────────

  r.post("/")
    .summary("Create gift card")
    .permission("gift-cards:admin")
    .input(
      z.object({
        amount: z.number().int().positive().describe("Amount in minor units (cents)"),
        currency: z.string().min(3).max(3).describe("ISO 4217 currency code"),
        recipientEmail: z.string().email().optional(),
        senderName: z.string().optional(),
        personalMessage: z.string().max(500).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .handler(async ({ input, orgId }) => {
      const body = input as {
        amount: number;
        currency: string;
        recipientEmail?: string;
        senderName?: string;
        personalMessage?: string;
        metadata?: Record<string, unknown>;
      };
      const result = await service.create(orgId, body);
      if (!result.ok) throw new Error(result.error);
      return {
        ...result.value,
        displayCode: formatCode(result.value.code),
      };
    });

  // ─── List Gift Cards ──────────────────────────────────────────────

  r.get("/")
    .summary("List gift cards")
    .permission("gift-cards:admin")
    .query(
      z.object({
        status: z.enum(["active", "disabled", "exhausted"]).optional(),
        purchaserId: z.string().optional(),
      }),
    )
    .handler(async ({ query, orgId }) => {
      const q = query as { status?: string; purchaserId?: string };
      const filters: { status?: "active" | "disabled" | "exhausted"; purchaserId?: string } = {};
      if (q.status === "active" || q.status === "disabled" || q.status === "exhausted") {
        filters.status = q.status;
      }
      if (q.purchaserId) filters.purchaserId = q.purchaserId;
      const result = await service.list(orgId, filters);
      if (!result.ok) throw new Error("Failed to list gift cards");
      return result.value;
    });

  // ─── Get Gift Card by ID ──────────────────────────────────────────

  r.get("/{id}")
    .summary("Get gift card details")
    .permission("gift-cards:admin")
    .handler(async ({ params, orgId }) => {
      const cardResult = await service.getById(orgId, params.id!);
      if (!cardResult.ok) throw new Error(cardResult.error);

      const txnResult = await service.getTransactions(orgId, cardResult.value.id);
      return {
        ...cardResult.value,
        displayCode: formatCode(cardResult.value.code),
        transactions: txnResult.ok ? txnResult.value : [],
      };
    });

  // ─── Disable Gift Card ────────────────────────────────────────────

  r.post("/{id}/disable")
    .summary("Disable gift card")
    .permission("gift-cards:admin")
    .handler(async ({ params, orgId }) => {
      const result = await service.disable(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  // ─── Manual Balance Adjustment ────────────────────────────────────

  r.post("/{id}/adjust")
    .summary("Adjust gift card balance")
    .permission("gift-cards:admin")
    .input(
      z.object({
        delta: z.number().int().describe("Adjustment amount in minor units (positive=credit, negative=debit)"),
        note: z.string().min(1).max(500).describe("Reason for adjustment"),
      }),
    )
    .handler(async ({ params, input, orgId }) => {
      const body = input as { delta: number; note: string };
      const result = await service.adjust(orgId, params.id!, body.delta, body.note);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
