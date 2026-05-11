/**
 * Loyalty Points Plugin — DB-backed, org-scoped
 *
 * Demonstrates:
 * - Plugin schema registration (Drizzle tables via manifest.schema)
 * - Hook registration (orders.afterCreate)
 * - Custom REST API routes backed by real DB queries
 * - Organization-scoped data isolation for SaaS multi-tenancy
 * - Integration with commerce.config.ts
 */

import {
  defineCommercePlugin,
  router,
  resolveOrgId,
  CommerceNotFoundError,
  CommerceValidationError,
  type PluginHookRegistration,
  type PluginRouteRegistration,
  type PluginContext,
} from "@porulle/core";
import { eq, and, desc, sql } from "@porulle/core/drizzle";
import { z } from "@hono/zod-openapi";
import { loyaltyPoints, loyaltyTransactions } from "./loyalty-schema.js";
import type { PostgresJsDatabase } from "@porulle/core/drizzle";

type Tier = "bronze" | "silver" | "gold" | "platinum";

interface CustomerService {
  getByUserId(userId: string, actor?: unknown): Promise<{ ok: boolean; value?: { id: string } }>;
}

interface LoyaltyPluginOptions {
  pointsPerDollar?: number;
  tierThresholds?: {
    silver: number;
    gold: number;
    platinum: number;
  };
}

function calculateTier(points: number, thresholds: { silver: number; gold: number; platinum: number }): Tier {
  if (points >= thresholds.platinum) return "platinum";
  if (points >= thresholds.gold) return "gold";
  if (points >= thresholds.silver) return "silver";
  return "bronze";
}

function drizzle(db: unknown): PostgresJsDatabase<Record<string, unknown>> {
  return db as PostgresJsDatabase<Record<string, unknown>>;
}

// ─── Inline Zod Schemas ─────────────────────────────────────────────────────

const RedeemPointsBodySchema = z.object({
  customerId: z.string().min(1).openapi({ example: "customer-uuid" }),
  pointsToRedeem: z.number().int().min(1).openapi({ example: 100 }),
}).openapi("RedeemPointsRequest");

// ─── Hooks ──────────────────────────────────────────────────────────────────

function buildHooks(options: LoyaltyPluginOptions): PluginHookRegistration[] {
  const thresholds = options.tierThresholds ?? { silver: 500, gold: 1500, platinum: 3000 };
  const pointsPerDollar = options.pointsPerDollar ?? 1;

  return [
    {
      key: "orders.afterCreate",
      async handler(args: unknown) {
        const { result, context } = args as {
          result: { id: string; customerId?: string; grandTotal: number; metadata?: Record<string, unknown> | null };
          context: {
            actor?: { organizationId?: string | null } | null;
            logger: { info(msg: string, data?: unknown): void };
            services: { database?: { db: unknown } };
          };
        };
        const customerId = result.customerId;
        const grandTotal = result.grandTotal;

        if (!customerId) return;

        const rawDb = context.services.database?.db;
        if (!rawDb) return;

        const orgId = resolveOrgId(context.actor);
        const pointsEarned = Math.floor((grandTotal / 100) * pointsPerDollar);
        if (pointsEarned <= 0) return;

        const db = drizzle(rawDb);

        // Insert loyalty transaction (org-scoped)
        await db.insert(loyaltyTransactions).values({
          organizationId: orgId,
          customerId,
          orderId: result.id,
          type: "earn",
          amount: pointsEarned,
          description: `Earned ${pointsEarned} points from order`,
        });

        // Upsert loyalty points (org-scoped unique on org+customer)
        await db
          .insert(loyaltyPoints)
          .values({
            organizationId: orgId,
            customerId,
            points: pointsEarned,
            lifetimeSpend: grandTotal,
            tier: calculateTier(pointsEarned, thresholds),
          })
          .onConflictDoUpdate({
            target: [loyaltyPoints.organizationId, loyaltyPoints.customerId],
            set: {
              points: sql`${loyaltyPoints.points} + ${pointsEarned}`,
              lifetimeSpend: sql`${loyaltyPoints.lifetimeSpend} + ${grandTotal}`,
              updatedAt: new Date(),
            },
          });

        // Re-read to calculate correct tier based on new total
        const [updated] = await db
          .select()
          .from(loyaltyPoints)
          .where(and(
            eq(loyaltyPoints.organizationId, orgId),
            eq(loyaltyPoints.customerId, customerId),
          ));

        if (updated) {
          const newTier = calculateTier(updated.points, thresholds);
          if (newTier !== updated.tier) {
            await db
              .update(loyaltyPoints)
              .set({ tier: newTier, updatedAt: new Date() })
              .where(and(
                eq(loyaltyPoints.organizationId, orgId),
                eq(loyaltyPoints.customerId, customerId),
              ));
          }
        }

        context.logger.info("loyalty_points_awarded", {
          customerId,
          orgId,
          pointsEarned,
          totalPoints: updated?.points ?? pointsEarned,
          tier: updated ? calculateTier(updated.points, thresholds) : "bronze",
        });
      },
    },
  ];
}

// ─── Routes ─────────────────────────────────────────────────────────────────

function buildRoutes(options: LoyaltyPluginOptions, ctx: PluginContext): PluginRouteRegistration[] {
  const { services, database } = ctx;
  const thresholds = options.tierThresholds ?? { silver: 500, gold: 1500, platinum: 3000 };

  const r = router("Loyalty", "/loyalty", ctx);

  // ─── GET /api/loyalty/points/:customerId — Get points (org-scoped) ─────
  r.get("/points/{customerId}").summary("Get loyalty points for a customer")
    .handler(async ({ params, actor }) => {
      const customerIdParam = params.customerId!;
      const orgId = resolveOrgId(actor);
      const db = drizzle(database.db);
      let loyalty: typeof loyaltyPoints.$inferSelect | undefined;

      // Try direct UUID lookup (org-scoped)
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(customerIdParam)) {
        [loyalty] = await db
          .select()
          .from(loyaltyPoints)
          .where(and(
            eq(loyaltyPoints.organizationId, orgId),
            eq(loyaltyPoints.customerId, customerIdParam),
          ));
      }

      // If not found, try to resolve as user_id to UUID
      if (!loyalty) {
        try {
          const customers = services.customers as CustomerService | undefined;
          const customerResult = await customers?.getByUserId(customerIdParam, actor);
          if (customerResult?.ok && customerResult.value) {
            [loyalty] = await db
              .select()
              .from(loyaltyPoints)
              .where(and(
                eq(loyaltyPoints.organizationId, orgId),
                eq(loyaltyPoints.customerId, customerResult.value.id),
              ));
          }
        } catch {
          // Customer lookup failed
        }
      }

      if (!loyalty) {
        return {
          customerId: customerIdParam,
          points: 0,
          tier: "bronze" as const,
          message: "No points yet. Start shopping to earn!",
        };
      }

      return loyalty;
    });

  // ─── GET /api/loyalty/leaderboard — Leaderboard (org-scoped) ───────────
  r.get("/leaderboard").summary("Get loyalty points leaderboard")
    .handler(async ({ actor }) => {
      const orgId = resolveOrgId(actor);
      const db = drizzle(database.db);
      const rows = await db
        .select()
        .from(loyaltyPoints)
        .where(eq(loyaltyPoints.organizationId, orgId))
        .orderBy(desc(loyaltyPoints.points))
        .limit(10);

      return rows.map((entry, index) => ({
        rank: index + 1,
        customerId: entry.customerId,
        points: entry.points,
        tier: entry.tier,
      }));
    });

  // ─── POST /api/loyalty/redeem — Redeem points (org-scoped) ─────────────
  r.post("/redeem").summary("Redeem loyalty points")
    .input(RedeemPointsBodySchema)
    .handler(async ({ input, actor }) => {
      const { customerId, pointsToRedeem } = input as z.infer<typeof RedeemPointsBodySchema>;
      const orgId = resolveOrgId(actor);
      const db = drizzle(database.db);
      let loyalty: typeof loyaltyPoints.$inferSelect | undefined;
      let resolvedCustomerId = customerId;

      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRe.test(customerId)) {
        [loyalty] = await db
          .select()
          .from(loyaltyPoints)
          .where(and(
            eq(loyaltyPoints.organizationId, orgId),
            eq(loyaltyPoints.customerId, customerId),
          ));
      }

      if (!loyalty) {
        try {
          const customers = services.customers as CustomerService | undefined;
          const customerResult = await customers?.getByUserId(customerId, actor);
          if (customerResult?.ok && customerResult.value) {
            resolvedCustomerId = customerResult.value.id;
            [loyalty] = await db
              .select()
              .from(loyaltyPoints)
              .where(and(
                eq(loyaltyPoints.organizationId, orgId),
                eq(loyaltyPoints.customerId, resolvedCustomerId),
              ));
          }
        } catch {
          // Customer lookup failed
        }
      }

      if (!loyalty) {
        throw new CommerceNotFoundError("No loyalty account found");
      }

      if (loyalty.points < pointsToRedeem) {
        throw new CommerceValidationError("Not enough points to redeem");
      }

      const newPoints = loyalty.points - pointsToRedeem;
      const newTier = calculateTier(newPoints, thresholds);

      await db
        .update(loyaltyPoints)
        .set({ points: newPoints, tier: newTier, updatedAt: new Date() })
        .where(and(
          eq(loyaltyPoints.organizationId, orgId),
          eq(loyaltyPoints.customerId, resolvedCustomerId),
        ));

      // Record redemption transaction (org-scoped)
      await db.insert(loyaltyTransactions).values({
        organizationId: orgId,
        customerId: resolvedCustomerId,
        type: "redeem",
        amount: pointsToRedeem,
        description: `Redeemed ${pointsToRedeem} points`,
      });

      return {
        message: `Successfully redeemed ${pointsToRedeem} points`,
        remainingPoints: newPoints,
        tier: newTier,
      };
    });

  return r.routes();
}

export function loyaltyPlugin(options: LoyaltyPluginOptions = {}) {
  return defineCommercePlugin({
    id: "loyalty",
    version: "1.0.0",
    schema: () => ({ loyaltyPoints, loyaltyTransactions }),
    hooks: () => buildHooks(options),
    routes: (ctx) => buildRoutes(options, ctx),
  });
}
