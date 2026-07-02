import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ExchangeService, ExchangeInput } from "../services/exchange-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

/**
 * Exchanges (issue #53): POST /pos/exchanges — return + replacement order +
 * net delta in one call. Requires pos:manage (like returns) plus core order
 * scopes on the actor (orders:update for the refund, orders:create for the
 * replacement) since the exchange moves money on core orders.
 */
export function buildExchangeRoutes(
  service: ExchangeService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Exchanges", "/pos/exchanges", ctx);

  r.post("/")
    .summary("Exchange — return lines + replacement order in one atomic operation")
    .permission("pos:manage")
    .input(z.object({
      shiftId: z.string().uuid(),
      terminalId: z.string().uuid(),
      originalOrderId: z.string().uuid(),
      currency: z.string().length(3).optional(),
      customerId: z.string().uuid().optional(),
      returnItems: z.array(z.object({
        originalLineItemId: z.string().uuid(),
        quantity: z.number().int().positive(),
        reason: z.enum(["defective", "wrong_item", "changed_mind", "other"]),
      })).min(1),
      replacementItems: z.array(z.object({
        entityId: z.string().uuid(),
        variantId: z.string().uuid().optional(),
        sku: z.string().optional(),
        title: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPrice: z.number().int().min(0),
        taxAmount: z.number().int().min(0).optional(),
      })).min(1),
    }))
    .handler(async ({ input, actor, orgId }) => {
      const result = await service.exchange(
        orgId,
        input as ExchangeInput,
        actor as { userId: string } & Record<string, unknown>,
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
