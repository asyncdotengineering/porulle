import { eq, and, inArray, lte, gte, or, isNull } from "drizzle-orm";
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
/** The columns price resolution reads: no `metadata`, `currency` (filtered in SQL) or `compareAtAmount`. */
export type ResolvablePrice = Pick<
  Price,
  | "id"
  | "entityId"
  | "variantId"
  | "amount"
  | "customerGroupId"
  | "minQuantity"
  | "maxQuantity"
  | "validFrom"
  | "validUntil"
  | "createdAt"
>;
/** The columns modifier application reads. */
export type ResolvableModifier = Pick<
  PriceModifier,
  | "id"
  | "name"
  | "type"
  | "value"
  | "priority"
  | "entityId"
  | "variantId"
  | "conditions"
  | "customerGroupId"
  | "minQuantity"
  | "maxQuantity"
  | "validFrom"
  | "validUntil"
>;

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

  /**
   * The base prices that can apply to any of `entityIds` (product-level rows, plus rows for any of
   * `variantIds`) at `at`, for `quantity` units in `currency`. Every filter that does not depend on
   * WHICH variant is asking runs here, in SQL; the caller picks per (entity, variant) in memory.
   */
  async findResolvablePrices(
    orgId: string,
    filter: {
      entityIds: string[];
      variantIds: string[];
      currency: string;
      quantity: number;
      customerGroupIds: string[];
      at: Date;
    },
    ctx?: TxContext,
  ): Promise<ResolvablePrice[]> {
    if (filter.entityIds.length === 0) return [];
    return this.getDb(ctx)
      .select({
        id: prices.id,
        entityId: prices.entityId,
        variantId: prices.variantId,
        amount: prices.amount,
        customerGroupId: prices.customerGroupId,
        minQuantity: prices.minQuantity,
        maxQuantity: prices.maxQuantity,
        validFrom: prices.validFrom,
        validUntil: prices.validUntil,
        createdAt: prices.createdAt,
      })
      .from(prices)
      .where(
        and(
          eq(prices.organizationId, orgId),
          inArray(prices.entityId, filter.entityIds),
          eq(prices.currency, filter.currency),
          filter.variantIds.length > 0
            ? or(isNull(prices.variantId), inArray(prices.variantId, filter.variantIds))
            : isNull(prices.variantId),
          or(isNull(prices.minQuantity), lte(prices.minQuantity, filter.quantity)),
          or(isNull(prices.maxQuantity), gte(prices.maxQuantity, filter.quantity)),
          or(isNull(prices.validFrom), lte(prices.validFrom, filter.at)),
          or(isNull(prices.validUntil), gte(prices.validUntil, filter.at)),
          filter.customerGroupIds.length > 0
            ? or(isNull(prices.customerGroupId), inArray(prices.customerGroupId, filter.customerGroupIds))
            : isNull(prices.customerGroupId),
        ),
      );
  }

  /**
   * Every base price and modifier that can EVER apply to `entityIds` in `currency` for the given customer groups, with
   * their quantity bounds and validity windows unfiltered: the inputs `resolvePriceAt` chooses from at any moment, for a
   * caller that stores them and prices later. Modifiers include the organization-wide ones (no entity).
   */
  async findPriceCandidates(
    orgId: string,
    filter: { entityIds: string[]; currency: string; customerGroupIds: string[] },
    ctx?: TxContext,
  ): Promise<{ prices: ResolvablePrice[]; modifiers: ResolvableModifier[] }> {
    if (filter.entityIds.length === 0) return { prices: [], modifiers: [] };
    const db = this.getDb(ctx);
    const [priceRows, modifierRows] = await Promise.all([
      db
        .select({
          id: prices.id,
          entityId: prices.entityId,
          variantId: prices.variantId,
          amount: prices.amount,
          customerGroupId: prices.customerGroupId,
          minQuantity: prices.minQuantity,
          maxQuantity: prices.maxQuantity,
          validFrom: prices.validFrom,
          validUntil: prices.validUntil,
          createdAt: prices.createdAt,
        })
        .from(prices)
        .where(
          and(
            eq(prices.organizationId, orgId),
            inArray(prices.entityId, filter.entityIds),
            eq(prices.currency, filter.currency),
            filter.customerGroupIds.length > 0
              ? or(isNull(prices.customerGroupId), inArray(prices.customerGroupId, filter.customerGroupIds))
              : isNull(prices.customerGroupId),
          ),
        ),
      db
        .select({
          id: priceModifiers.id,
          name: priceModifiers.name,
          type: priceModifiers.type,
          value: priceModifiers.value,
          priority: priceModifiers.priority,
          entityId: priceModifiers.entityId,
          variantId: priceModifiers.variantId,
          conditions: priceModifiers.conditions,
          customerGroupId: priceModifiers.customerGroupId,
          minQuantity: priceModifiers.minQuantity,
          maxQuantity: priceModifiers.maxQuantity,
          validFrom: priceModifiers.validFrom,
          validUntil: priceModifiers.validUntil,
        })
        .from(priceModifiers)
        .where(
          and(
            eq(priceModifiers.organizationId, orgId),
            or(isNull(priceModifiers.entityId), inArray(priceModifiers.entityId, filter.entityIds)),
            or(isNull(priceModifiers.currency), eq(priceModifiers.currency, filter.currency)),
            filter.customerGroupIds.length > 0
              ? or(isNull(priceModifiers.customerGroupId), inArray(priceModifiers.customerGroupId, filter.customerGroupIds))
              : isNull(priceModifiers.customerGroupId),
          ),
        ),
    ]);
    return { prices: priceRows, modifiers: modifierRows };
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

  async findModifiers(
    orgId: string,
    filter?: { entityId?: string; currency?: string; activeAt?: Date },
    ctx?: TxContext,
  ): Promise<PriceModifier[]> {
    const db = this.getDb(ctx);
    const conditions = [eq(priceModifiers.organizationId, orgId)];
    if (filter?.entityId) {
      conditions.push(eq(priceModifiers.entityId, filter.entityId));
    }
    if (filter?.currency) {
      conditions.push(eq(priceModifiers.currency, filter.currency));
    }
    if (filter?.activeAt) {
      conditions.push(
        or(
          isNull(priceModifiers.validFrom),
          lte(priceModifiers.validFrom, filter.activeAt),
        )!,
      );
      conditions.push(
        or(
          isNull(priceModifiers.validUntil),
          gte(priceModifiers.validUntil, filter.activeAt),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(priceModifiers)
      .where(and(...conditions));
    return rows.sort((a, b) => a.priority - b.priority);
  }

  /**
   * The modifiers that can apply to any of `entityIds` (or to every entity) and to product-level
   * prices or any of `variantIds`, active at `at`, for `quantity` units in `currency`, unscoped or
   * scoped to `customerGroupId`. The caller picks per (entity, variant) in memory.
   */
  async findResolvableModifiers(
    orgId: string,
    filter: {
      entityIds: string[];
      variantIds: string[];
      currency: string;
      quantity: number;
      customerGroupId: string | undefined;
      at: Date;
    },
    ctx?: TxContext,
  ): Promise<ResolvableModifier[]> {
    if (filter.entityIds.length === 0) return [];
    return this.getDb(ctx)
      .select({
        id: priceModifiers.id,
        name: priceModifiers.name,
        type: priceModifiers.type,
        value: priceModifiers.value,
        priority: priceModifiers.priority,
        entityId: priceModifiers.entityId,
        variantId: priceModifiers.variantId,
        conditions: priceModifiers.conditions,
        customerGroupId: priceModifiers.customerGroupId,
        minQuantity: priceModifiers.minQuantity,
        maxQuantity: priceModifiers.maxQuantity,
        validFrom: priceModifiers.validFrom,
        validUntil: priceModifiers.validUntil,
      })
      .from(priceModifiers)
      .where(
        and(
          eq(priceModifiers.organizationId, orgId),
          or(isNull(priceModifiers.entityId), inArray(priceModifiers.entityId, filter.entityIds)),
          filter.variantIds.length > 0
            ? or(isNull(priceModifiers.variantId), inArray(priceModifiers.variantId, filter.variantIds))
            : isNull(priceModifiers.variantId),
          or(isNull(priceModifiers.currency), eq(priceModifiers.currency, filter.currency)),
          or(isNull(priceModifiers.minQuantity), lte(priceModifiers.minQuantity, filter.quantity)),
          or(isNull(priceModifiers.maxQuantity), gte(priceModifiers.maxQuantity, filter.quantity)),
          or(isNull(priceModifiers.validFrom), lte(priceModifiers.validFrom, filter.at)),
          or(isNull(priceModifiers.validUntil), gte(priceModifiers.validUntil, filter.at)),
          filter.customerGroupId !== undefined
            ? or(isNull(priceModifiers.customerGroupId), eq(priceModifiers.customerGroupId, filter.customerGroupId))
            : isNull(priceModifiers.customerGroupId),
        ),
      );
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
