import { eq, and, desc, lte, gte, isNull, or } from "@porulle/core/drizzle";
import { contractPrices } from "../schema.js";
import type { Db } from "../types.js";

export class ContractPriceService {
  constructor(private db: Db) {}

  async create(data: {
    vendorId: string;
    buyerId: string;
    entityId: string;
    variantId?: string;
    priceCents: number;
    minQuantity?: number;
    currency?: string;
    validFrom?: Date | undefined;
    validUntil?: Date | undefined;
  }) {
    const [price] = await this.db.insert(contractPrices).values(data).returning();
    return price;
  }

  async update(id: string, data: Record<string, unknown>) {
    const [updated] = await this.db.update(contractPrices).set(data)
      .where(eq(contractPrices.id, id)).returning();
    return updated ?? null;
  }

  async delete(id: string) {
    await this.db.delete(contractPrices).where(eq(contractPrices.id, id));
  }

  async list(filters?: { vendorId?: string; buyerId?: string }) {
    let query = this.db.select().from(contractPrices).$dynamic();
    const conditions = [];
    if (filters?.vendorId) conditions.push(eq(contractPrices.vendorId, filters.vendorId));
    if (filters?.buyerId) conditions.push(eq(contractPrices.buyerId, filters.buyerId));
    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
    }
    return query.orderBy(desc(contractPrices.createdAt));
  }

  /**
   * Resolve the best contract price for a buyer+vendor+entity+quantity.
   * Returns null if no matching contract exists.
   */
  async resolvePrice(
    vendorId: string,
    buyerId: string,
    entityId: string,
    variantId: string | null,
    quantity: number,
  ): Promise<number | null> {
    const now = new Date();
    const all = await this.db.select().from(contractPrices)
      .where(
        and(
          eq(contractPrices.vendorId, vendorId),
          eq(contractPrices.buyerId, buyerId),
          eq(contractPrices.entityId, entityId),
        ),
      )
      .orderBy(desc(contractPrices.priceCents));

    for (const cp of all) {
      // Check variant match
      if (variantId != null && cp.variantId != null && cp.variantId !== variantId) continue;
      // Check quantity
      if (quantity < (cp.minQuantity ?? 1)) continue;
      // Check time validity
      if (cp.validFrom && cp.validFrom > now) continue;
      if (cp.validUntil && cp.validUntil < now) continue;

      return cp.priceCents;
    }

    return null;
  }
}
