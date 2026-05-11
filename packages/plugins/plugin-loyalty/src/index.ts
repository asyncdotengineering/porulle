import { defineCommercePlugin, resolveOrgId } from "@porulle/core";
import { eq, and, sql } from "@porulle/core/drizzle";
import { loyaltyPoints, loyaltyTransactions, loyaltyRedemptionOffers } from "./schema.js";
import { LoyaltyService } from "./services/loyalty-service.js";
import { buildLoyaltyRoutes } from "./routes/loyalty.js";
import type { Db, LoyaltyPluginOptions } from "./types.js";
import { DEFAULT_LOYALTY_OPTIONS } from "./types.js";

export type { LoyaltyPluginOptions, Db } from "./types.js";
export { LoyaltyService } from "./services/loyalty-service.js";

export function loyaltyPlugin(userOptions: LoyaltyPluginOptions = {}) {
  const options: Required<LoyaltyPluginOptions> = { ...DEFAULT_LOYALTY_OPTIONS, ...userOptions };

  return defineCommercePlugin({
    id: "loyalty",
    version: "1.0.0",
    permissions: [
      { scope: "loyalty:admin", description: "Create/manage redemption offers, view all loyalty data." },
    ],
    schema: () => ({ loyaltyPoints, loyaltyTransactions, loyaltyRedemptionOffers }),
    hooks: () => [{
      key: "orders.afterCreate",
      async handler(args: unknown) {
        const { result, context } = args as {
          result: { id: string; customerId?: string; grandTotal: number };
          context: { actor?: { organizationId?: string | null } | null; logger: { info(msg: string, data?: unknown): void }; services: { database?: { db: unknown } } };
        };
        if (!result.customerId) return;
        const rawDb = context.services.database?.db;
        if (!rawDb) return;

        const orgId = resolveOrgId(context.actor);
        const pointsEarned = Math.floor((result.grandTotal / 100) * options.pointsPerDollar);
        if (pointsEarned <= 0) return;

        const db = rawDb as Db;
        const service = new LoyaltyService(db, options.tierThresholds);
        await service.earnPoints(orgId, result.customerId, pointsEarned, result.id);

        context.logger.info("loyalty_points_awarded", { customerId: result.customerId, orgId, pointsEarned });
      },
    }],
    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      return buildLoyaltyRoutes(new LoyaltyService(db, options.tierThresholds), ctx);
    },
  });
}
