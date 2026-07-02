import { defineCommercePlugin, router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { PluginRouteRegistration } from "@porulle/core";
import { layaways, layawayPayments } from "./schema.js";
import { LayawayService, type LayawayPluginOptions } from "./service.js";

export type { LayawayPluginOptions, Layaway, LayawayPayment } from "./service.js";
export { LayawayService } from "./service.js";
export type { LayawayItem } from "./schema.js";

const ItemSchema = z.object({
  entityId: z.string().uuid(),
  variantId: z.string().uuid().optional(),
  sku: z.string().optional(),
  title: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().int().min(0),
});

/**
 * Layaway plugin (issue #58): partial-payment plans — reserve items with a
 * deposit, record installments (any tender), derived status, automatic
 * completion to a core order (with the stock hold released) at full payment,
 * and a forfeit policy hook.
 *
 * The actor needs `layaway:operate` for day-to-day flows and core
 * `orders:create` (completion creates the order).
 */
export function layawayPlugin(options: LayawayPluginOptions = {}) {
  return defineCommercePlugin({
    id: "layaway",
    version: "1.0.0",

    permissions: [
      { scope: "layaway:operate", description: "Create layaway plans, record installment payments." },
      { scope: "layaway:manage", description: "Forfeit or cancel layaway plans." },
    ],

    schema: () => ({ layaways, layawayPayments }),

    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      const service = new LayawayService(db, ctx.services, options);
      const r = router("Layaways", "/layaways", ctx);

      r.post("/")
        .summary("Create a layaway plan (reserves stock; optional initial deposit payment)")
        .permission("layaway:operate")
        .input(z.object({
          currency: z.string().length(3),
          customerId: z.string().uuid().optional(),
          items: z.array(ItemSchema).min(1),
          depositAmount: z.number().int().min(0).optional(),
          depositPercent: z.number().min(0).max(100).optional(),
          expiresAt: z.string().datetime().optional(),
          initialPayment: z.object({
            amount: z.number().int().positive(),
            method: z.string().min(1),
            reference: z.string().optional(),
          }).optional(),
        }))
        .handler(async ({ input, actor, orgId }) => {
          const result = await service.create(
            orgId,
            input as Parameters<LayawayService["create"]>[1],
            actor as { userId: string } & Record<string, unknown>,
          );
          if (!result.ok) throw new Error(result.error);
          return result.value;
        });

      r.get("/")
        .summary("List layaway plans")
        .permission("layaway:operate")
        .query(z.object({ status: z.string().optional() }))
        .handler(async ({ query, orgId }) => {
          const result = await service.list(orgId, (query as { status?: string }).status);
          if (!result.ok) throw new Error(result.error);
          return result.value;
        });

      r.get("/{id}")
        .summary("Get a layaway plan with its payment ledger")
        .permission("layaway:operate")
        .handler(async ({ params, orgId }) => {
          const result = await service.getById(orgId, params.id!);
          if (!result.ok) throw new Error(result.error);
          return result.value;
        });

      r.post("/{id}/payments")
        .summary("Record an installment (completes the plan at full payment)")
        .permission("layaway:operate")
        .input(z.object({
          amount: z.number().int().positive(),
          method: z.string().min(1),
          reference: z.string().optional(),
        }))
        .handler(async ({ params, input, actor, orgId }) => {
          const result = await service.addPayment(
            orgId,
            params.id!,
            input as { amount: number; method: string; reference?: string },
            actor as { userId: string } & Record<string, unknown>,
          );
          if (!result.ok) throw new Error(result.error);
          return result.value;
        });

      r.post("/{id}/forfeit")
        .summary("Forfeit an active plan (releases stock, runs the forfeit policy)")
        .permission("layaway:manage")
        .input(z.object({ reason: z.string().max(500).optional() }))
        .handler(async ({ params, input, actor, orgId }) => {
          const result = await service.forfeit(
            orgId,
            params.id!,
            (input as { reason?: string }).reason,
            actor as { userId: string } & Record<string, unknown>,
          );
          if (!result.ok) throw new Error(result.error);
          return result.value;
        });

      return r.routes() as PluginRouteRegistration[];
    },
  });
}
