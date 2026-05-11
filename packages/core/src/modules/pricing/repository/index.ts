import { eq, and, lte, gte, or, isNull } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { prices, priceModifiers } from "../schema.js";

// Infer types from Drizzle schema
export type Price = typeof prices.$inferSelect;
export type PriceInsert = typeof prices.$inferInsert;
export type PriceModifier = typeof priceModifiers.$inferSelect;
export type PriceModifierInsert = typeof priceModifiers.$inferInsert;

/**
 * PricingRepository provides type-safe database operations for pricing.
 *
 * This repository manages prices and price modifiers.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class PricingRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Prices
  // ─────────────────────────────────────────────────────────────────────────────

  async findPriceById(orgId: string, id: string, ctx?: TxContext): Promise<Price | undefined> {
    const db = this.getDb(ctx);
    const rows = await db.select().from(prices).where(
      and(eq(prices.organizationId, orgId), eq(prices.id, id)),
    );
    return rows[0];
  }

  async findPricesByEntityId(
    orgId: string,
    entityId: string,
    ctx?: TxContext,
  ): Promise<Price[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(prices)
      .where(
        and(eq(prices.organizationId, orgId), eq(prices.entityId, entityId)),
      );
  }

  async findPricesByEntityAndVariant(
    entityId: string,
    variantId: string | null,
    ctx?: TxContext,
  ): Promise<Price[]> {
    const db = this.getDb(ctx);

    if (variantId === null) {
      return db
        .select()
        .from(prices)
        .where(and(eq(prices.entityId, entityId), isNull(prices.variantId)));
    }

    return db
      .select()
      .from(prices)
      .where(
        and(eq(prices.entityId, entityId), eq(prices.variantId, variantId)),
      );
  }

  async findActivePrices(
    entityId: string,
    currency: string,
    variantId?: string,
    customerGroupId?: string,
    quantity?: number,
    ctx?: TxContext,
  ): Promise<Price[]> {
    const db = this.getDb(ctx);
    const now = new Date();

    const rows = await db
      .select()
      .from(prices)
      .where(
        and(
          eq(prices.entityId, entityId),
          eq(prices.currency, currency),
          or(isNull(prices.validFrom), lte(prices.validFrom, now)),
          or(isNull(prices.validUntil), gte(prices.validUntil, now)),
        ),
      );

    // Filter by variantId
    let filtered = rows.filter((p) => {
      if (variantId === undefined) return p.variantId === null;
      return p.variantId === variantId || p.variantId === null;
    });

    // Filter by customerGroupId
    if (customerGroupId) {
      filtered = filtered.filter(
        (p) =>
          p.customerGroupId === null || p.customerGroupId === customerGroupId,
      );
    } else {
      filtered = filtered.filter((p) => p.customerGroupId === null);
    }

    // Filter by quantity
    if (quantity !== undefined) {
      filtered = filtered.filter((p) => {
        const minOk = p.minQuantity === null || quantity >= p.minQuantity;
        const maxOk = p.maxQuantity === null || quantity <= p.maxQuantity;
        return minOk && maxOk;
      });
    }

    return filtered;
  }

  async createPrice(data: PriceInsert, ctx?: TxContext): Promise<Price> {
    const db = this.getDb(ctx);
    const rows = await db.insert(prices).values(data).returning();
    return rows[0]!;
  }

  async updatePrice(
    id: string,
    data: Partial<Omit<PriceInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Price | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(prices)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(prices.id, id))
      .returning();
    return rows[0];
  }

  async deletePrice(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db.delete(prices).where(eq(prices.id, id)).returning();
    return result.length > 0;
  }

  async deletePricesByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(prices).where(eq(prices.entityId, entityId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Price Modifiers
  // ─────────────────────────────────────────────────────────────────────────────

  async findModifierById(
    orgId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<PriceModifier | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(priceModifiers)
      .where(and(eq(priceModifiers.organizationId, orgId), eq(priceModifiers.id, id)));
    return rows[0];
  }

  async findModifiersByEntityId(
    orgId: string,
    entityId: string,
    ctx?: TxContext,
  ): Promise<PriceModifier[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(priceModifiers)
      .where(
        and(
          eq(priceModifiers.organizationId, orgId),
          eq(priceModifiers.entityId, entityId),
        ),
      );
  }

  async findActiveModifiers(
    orgId: string,
    entityId: string,
    variantId?: string,
    customerGroupId?: string,
    currency?: string,
    quantity?: number,
    ctx?: TxContext,
  ): Promise<PriceModifier[]> {
    const db = this.getDb(ctx);
    const now = new Date();

    const rows = await db
      .select()
      .from(priceModifiers)
      .where(
        and(
          eq(priceModifiers.organizationId, orgId),
          or(
            isNull(priceModifiers.entityId),
            eq(priceModifiers.entityId, entityId),
          ),
          or(
            isNull(priceModifiers.validFrom),
            lte(priceModifiers.validFrom, now),
          ),
          or(
            isNull(priceModifiers.validUntil),
            gte(priceModifiers.validUntil, now),
          ),
        ),
      );

    // Filter by variantId
    let filtered = rows.filter((m) => {
      if (m.variantId === null) return true;
      return m.variantId === variantId;
    });

    // Filter by customerGroupId
    if (customerGroupId) {
      filtered = filtered.filter(
        (m) =>
          m.customerGroupId === null || m.customerGroupId === customerGroupId,
      );
    } else {
      filtered = filtered.filter((m) => m.customerGroupId === null);
    }

    // Filter by currency
    if (currency) {
      filtered = filtered.filter(
        (m) => m.currency === null || m.currency === currency,
      );
    }

    // Filter by quantity
    if (quantity !== undefined) {
      filtered = filtered.filter((m) => {
        const minOk = m.minQuantity === null || quantity >= m.minQuantity;
        const maxOk = m.maxQuantity === null || quantity <= m.maxQuantity;
        return minOk && maxOk;
      });
    }

    // Sort by priority (lower number = higher priority)
    return filtered.sort((a, b) => a.priority - b.priority);
  }

  async createModifier(
    data: PriceModifierInsert,
    ctx?: TxContext,
  ): Promise<PriceModifier> {
    const db = this.getDb(ctx);
    const rows = await db.insert(priceModifiers).values(data).returning();
    return rows[0]!;
  }

  async updateModifier(
    id: string,
    data: Partial<Omit<PriceModifierInsert, "id">>,
    ctx?: TxContext,
  ): Promise<PriceModifier | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(priceModifiers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(priceModifiers.id, id))
      .returning();
    return rows[0];
  }

  async deleteModifier(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(priceModifiers)
      .where(eq(priceModifiers.id, id))
      .returning();
    return result.length > 0;
  }

  async deleteModifiersByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(priceModifiers)
      .where(eq(priceModifiers.entityId, entityId));
  }
}
