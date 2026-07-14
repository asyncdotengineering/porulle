import { eq, and, desc, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { loyaltyPoints, loyaltyTransactions, loyaltyRedemptionOffers } from "../schema.js";
import type { Db, LoyaltyPoints, LoyaltyOffer, Tier } from "../types.js";

function calculateTier(points: number, thresholds: { silver: number; gold: number; platinum: number }): Tier {
  if (points >= thresholds.platinum) return "platinum";
  if (points >= thresholds.gold) return "gold";
  if (points >= thresholds.silver) return "silver";
  return "bronze";
}

export class LoyaltyService {
  constructor(private db: Db, private thresholds: { silver: number; gold: number; platinum: number }) {}

  async getPoints(orgId: string, customerId: string): Promise<PluginResult<LoyaltyPoints | null>> {
    const rows = await this.db.select().from(loyaltyPoints)
      .where(and(eq(loyaltyPoints.organizationId, orgId), eq(loyaltyPoints.customerId, customerId)));
    return Ok(rows[0] ?? null);
  }

  async earnPoints(orgId: string, customerId: string, amount: number, orderId?: string): Promise<PluginResult<LoyaltyPoints>> {
    if (amount <= 0) return Err("Amount must be positive");

    await this.db.insert(loyaltyTransactions).values({
      organizationId: orgId, customerId, orderId, type: "earn", amount,
      description: `Earned ${amount} points`,
    });

    await this.db.insert(loyaltyPoints).values({
      organizationId: orgId, customerId, points: amount, lifetimeSpend: 0,
      tier: calculateTier(amount, this.thresholds),
    }).onConflictDoUpdate({
      target: [loyaltyPoints.organizationId, loyaltyPoints.customerId],
      set: {
        points: sql`${loyaltyPoints.points} + ${amount}`,
        updatedAt: new Date(),
      },
    });

    const [updated] = await this.db.select().from(loyaltyPoints)
      .where(and(eq(loyaltyPoints.organizationId, orgId), eq(loyaltyPoints.customerId, customerId)));

    if (updated) {
      const newTier = calculateTier(updated.points, this.thresholds);
      if (newTier !== updated.tier) {
        await this.db.update(loyaltyPoints).set({ tier: newTier, updatedAt: new Date() })
          .where(and(eq(loyaltyPoints.organizationId, orgId), eq(loyaltyPoints.customerId, customerId)));
        return Ok({ ...updated, tier: newTier });
      }
    }

    return Ok(updated!);
  }

  async redeemPoints(orgId: string, customerId: string, amount: number): Promise<PluginResult<LoyaltyPoints>> {
    if (amount <= 0) return Err("Amount must be positive");

    // Atomic check-and-deduct: lock the row to prevent concurrent double-spend
    const [loyalty] = await this.db.select().from(loyaltyPoints)
      .where(and(eq(loyaltyPoints.organizationId, orgId), eq(loyaltyPoints.customerId, customerId)))
      .for("update");
    if (!loyalty) return Err("No loyalty account found");
    if (loyalty.points < amount) return Err("Not enough points");

    const newPoints = loyalty.points - amount;
    const newTier = calculateTier(newPoints, this.thresholds);

    await this.db.update(loyaltyPoints).set({ points: newPoints, tier: newTier, updatedAt: new Date() })
      .where(and(eq(loyaltyPoints.organizationId, orgId), eq(loyaltyPoints.customerId, customerId)));

    await this.db.insert(loyaltyTransactions).values({
      organizationId: orgId, customerId, type: "redeem", amount,
      description: `Redeemed ${amount} points`,
    });

    return Ok({ ...loyalty, points: newPoints, tier: newTier });
  }

  async getLeaderboard(orgId: string, limit = 10): Promise<PluginResult<LoyaltyPoints[]>> {
    const rows = await this.db.select().from(loyaltyPoints)
      .where(eq(loyaltyPoints.organizationId, orgId))
      .orderBy(desc(loyaltyPoints.points)).limit(limit);
    return Ok(rows);
  }

  // ─── Offers ────────────────────────────────────────────────────────

  async createOffer(orgId: string, input: {
    name: string; pointsRequired: number; rewardType: "discount_percentage" | "discount_fixed" | "free_item" | "free_shipping";
    rewardValue: number; rewardEntityId?: string; validFrom?: string; validUntil?: string; maxRedemptions?: number;
  }): Promise<PluginResult<LoyaltyOffer>> {
    const rows = await this.db.insert(loyaltyRedemptionOffers).values({
      organizationId: orgId, name: input.name, pointsRequired: input.pointsRequired,
      rewardType: input.rewardType, rewardValue: input.rewardValue,
      rewardEntityId: input.rewardEntityId,
      ...(input.validFrom ? { validFrom: new Date(input.validFrom) } : {}),
      ...(input.validUntil ? { validUntil: new Date(input.validUntil) } : {}),
      maxRedemptions: input.maxRedemptions,
    }).returning();
    return Ok(rows[0]!);
  }

  async listOffers(orgId: string): Promise<PluginResult<LoyaltyOffer[]>> {
    const rows = await this.db.select().from(loyaltyRedemptionOffers)
      .where(and(eq(loyaltyRedemptionOffers.organizationId, orgId), eq(loyaltyRedemptionOffers.isActive, true)));
    return Ok(rows);
  }

  async redeemOffer(orgId: string, customerId: string, offerId: string): Promise<PluginResult<{ offer: LoyaltyOffer; remainingPoints: number }>> {
    // Lock offer row to prevent concurrent over-redemption
    const [offer] = await this.db.select().from(loyaltyRedemptionOffers)
      .where(and(eq(loyaltyRedemptionOffers.id, offerId), eq(loyaltyRedemptionOffers.organizationId, orgId)))
      .for("update");
    if (!offer) return Err("Offer not found");
    if (!offer.isActive) return Err("Offer is not active");
    if (offer.maxRedemptions && offer.timesRedeemed >= offer.maxRedemptions) return Err("Offer fully redeemed");

    // redeemPoints also uses FOR UPDATE — safe within same transaction context
    const redeemResult = await this.redeemPoints(orgId, customerId, offer.pointsRequired);
    if (!redeemResult.ok) return redeemResult;

    await this.db.update(loyaltyRedemptionOffers)
      .set({ timesRedeemed: sql`${loyaltyRedemptionOffers.timesRedeemed} + 1`, updatedAt: new Date() })
      .where(and(eq(loyaltyRedemptionOffers.id, offerId), eq(loyaltyRedemptionOffers.organizationId, orgId)));

    return Ok({ offer, remainingPoints: redeemResult.value.points });
  }
}
