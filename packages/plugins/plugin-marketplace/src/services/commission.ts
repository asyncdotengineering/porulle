import { eq, and, desc, lte, gte, isNull, or } from "@porulle/core/drizzle";
import { commissionRules, vendors } from "../schema.js";
import type { Db, MarketplacePluginOptions } from "../types.js";

export class CommissionService {
  constructor(
    private db: Db,
    private options: MarketplacePluginOptions,
  ) {}

  async createRule(data: {
    name: string;
    type: string;
    rateBps: number;
    categorySlug?: string;
    vendorId?: string;
    vendorTier?: string;
    minVolumeCents?: number;
    maxVolumeCents?: number;
    validFrom?: Date | undefined;
    validUntil?: Date | undefined;
    priority?: number;
  }) {
    const [rule] = await this.db.insert(commissionRules).values(data).returning();
    return rule;
  }

  async updateRule(id: string, data: Record<string, unknown>) {
    const [updated] = await this.db.update(commissionRules).set(data)
      .where(eq(commissionRules.id, id)).returning();
    return updated ?? null;
  }

  async deleteRule(id: string) {
    await this.db.delete(commissionRules).where(eq(commissionRules.id, id));
  }

  async listRules() {
    return this.db.select().from(commissionRules).orderBy(desc(commissionRules.priority));
  }

  /**
   * Resolve the effective commission rate for a given vendor+category+volume.
   * Priority order per RFC §5.2:
   *   1. Vendor-specific + category-specific
   *   2. Category-specific (any vendor)
   *   3. Vendor tier rule
   *   4. Volume tier rule
   *   5. Promotional rule
   *   6. Vendor-level flat rate
   *   7. Plugin default
   */
  async resolveRate(vendorId: string, categorySlug?: string, volumeCents?: number): Promise<number> {
    const now = new Date();
    const rules = await this.db.select().from(commissionRules)
      .where(eq(commissionRules.isActive, true))
      .orderBy(desc(commissionRules.priority));

    // Load vendor for tier and flat rate fallback
    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.id, vendorId));

    for (const rule of rules) {
      // Check time validity
      if (rule.validFrom && rule.validFrom > now) continue;
      if (rule.validUntil && rule.validUntil < now) continue;

      // 1. Vendor-specific + category-specific
      if (rule.type === "category" && rule.vendorId === vendorId && rule.categorySlug === categorySlug) {
        return rule.rateBps;
      }
    }

    for (const rule of rules) {
      if (rule.validFrom && rule.validFrom > now) continue;
      if (rule.validUntil && rule.validUntil < now) continue;

      // 2. Category-specific (any vendor)
      if (rule.type === "category" && !rule.vendorId && rule.categorySlug === categorySlug) {
        return rule.rateBps;
      }
    }

    for (const rule of rules) {
      if (rule.validFrom && rule.validFrom > now) continue;
      if (rule.validUntil && rule.validUntil < now) continue;

      // 3. Vendor tier
      if (rule.type === "vendor_tier" && vendor && rule.vendorTier === vendor.tier) {
        return rule.rateBps;
      }

      // 4. Volume tier
      if (rule.type === "volume_tier" && volumeCents != null) {
        const min = rule.minVolumeCents ?? 0;
        const max = rule.maxVolumeCents ?? Number.MAX_SAFE_INTEGER;
        if (volumeCents >= min && volumeCents <= max) {
          return rule.rateBps;
        }
      }

      // 5. Promotional
      if (rule.type === "promotional") {
        if (!rule.vendorId || rule.vendorId === vendorId) {
          return rule.rateBps;
        }
      }
    }

    // 6. Vendor flat rate
    if (vendor) return vendor.commissionRateBps;

    // 7. Plugin default
    return this.options.defaultCommissionRateBps ?? 1000;
  }

  async previewRate(vendorId: string, categorySlug?: string, volumeCents?: number) {
    const rateBps = await this.resolveRate(vendorId, categorySlug, volumeCents);
    return { rateBps, ratePercent: rateBps / 100 };
  }
}
