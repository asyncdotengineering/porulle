import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { LoyaltyService } from "../services/loyalty-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildLoyaltyRoutes(
  service: LoyaltyService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Loyalty", "/loyalty", ctx);

  r.get("/points/{customerId}").summary("Get loyalty points (admin)").permission("loyalty:admin")
    .handler(async ({ params, orgId }) => {
      const result = await service.getPoints(orgId, params.customerId!);
      if (!result.ok) throw new Error("Failed");
      if (!result.value) return { customerId: params.customerId, points: 0, tier: "bronze", message: "No points yet" };
      return result.value;
    });

  r.get("/leaderboard").summary("Loyalty leaderboard").auth()
    .handler(async ({ orgId }) => {
      const result = await service.getLeaderboard(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value.map((e: { customerId: string; points: number; tier: string }, i: number) => ({ rank: i + 1, customerId: e.customerId, points: e.points, tier: e.tier }));
    });

  r.post("/redeem").summary("Redeem points (admin)").permission("loyalty:admin")
    .input(z.object({ customerId: z.string().min(1), pointsToRedeem: z.number().int().min(1) }))
    .handler(async ({ input, orgId }) => {
      const body = input as { customerId: string; pointsToRedeem: number };
      const result = await service.redeemPoints(orgId, body.customerId, body.pointsToRedeem);
      if (!result.ok) throw new Error(result.error);
      return { remainingPoints: result.value.points, tier: result.value.tier };
    });

  // ─── Offers ────────────────────────────────────────────────────

  r.post("/offers").summary("Create redemption offer").permission("loyalty:admin")
    .input(z.object({
      name: z.string().min(1), pointsRequired: z.number().int().positive(),
      rewardType: z.enum(["discount_percentage", "discount_fixed", "free_item", "free_shipping"]),
      rewardValue: z.number().int(), rewardEntityId: z.string().uuid().optional(),
      validFrom: z.string().optional(), validUntil: z.string().optional(),
      maxRedemptions: z.number().int().positive().optional(),
    }))
    .handler(async ({ input, orgId }) => {
      const result = await service.createOffer(orgId, input as Parameters<typeof service.createOffer>[1]);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/offers").summary("List active offers").auth()
    .handler(async ({ orgId }) => {
      const result = await service.listOffers(orgId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/offers/{id}/redeem").summary("Redeem an offer (admin)").permission("loyalty:admin")
    .input(z.object({ customerId: z.string().min(1) }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { customerId: string };
      const result = await service.redeemOffer(orgId, body.customerId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
