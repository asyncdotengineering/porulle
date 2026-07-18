import { eq, and, lte, gte, or, isNull, desc, sql } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { promotions, promotionUsages } from "../schema.js";

// Infer types from Drizzle schema
export type Promotion = typeof promotions.$inferSelect;
export type PromotionInsert = typeof promotions.$inferInsert;
export type PromotionUsage = typeof promotionUsages.$inferSelect;
export type PromotionUsageInsert = typeof promotionUsages.$inferInsert;

/**
 * PromotionsRepository provides type-safe database operations for promotions.
 *
 * This repository manages promotions and their usage tracking.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class PromotionsRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Promotions
  // ─────────────────────────────────────────────────────────────────────────────

  async findById(orgId: string, id: string, ctx?: TxContext): Promise<Promotion | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(promotions)
      .where(and(eq(promotions.organizationId, orgId), eq(promotions.id, id)));
    return rows[0];
  }

  async findByCode(
    orgId: string,
    code: string,
    ctx?: TxContext,
  ): Promise<Promotion | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.organizationId, orgId),
          eq(promotions.code, code),
        ),
      );
    return rows[0];
  }

  async findAll(orgId: string, ctx?: TxContext): Promise<Promotion[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(promotions)
      .where(eq(promotions.organizationId, orgId))
      .orderBy(desc(promotions.priority));
  }

  async findActive(orgId: string, ctx?: TxContext): Promise<Promotion[]> {
    const db = this.getDb(ctx);
    const now = new Date();

    return db
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.organizationId, orgId),
          eq(promotions.isActive, true),
          or(isNull(promotions.validFrom), lte(promotions.validFrom, now)),
          or(isNull(promotions.validUntil), gte(promotions.validUntil, now)),
        ),
      )
      .orderBy(desc(promotions.priority));
  }

  async findAutomatic(orgId: string, ctx?: TxContext): Promise<Promotion[]> {
    const db = this.getDb(ctx);
    const now = new Date();

    return db
      .select()
      .from(promotions)
      .where(
        and(
          eq(promotions.organizationId, orgId),
          eq(promotions.isActive, true),
          eq(promotions.isAutomatic, true),
          or(isNull(promotions.validFrom), lte(promotions.validFrom, now)),
          or(isNull(promotions.validUntil), gte(promotions.validUntil, now)),
        ),
      )
      .orderBy(desc(promotions.priority));
  }

  async create(data: PromotionInsert, ctx?: TxContext): Promise<Promotion> {
    const db = this.getDb(ctx);
    const rows = await db.insert(promotions).values(data).returning();
    return rows[0]!;
  }

  async update(
    id: string,
    data: Partial<Omit<PromotionInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Promotion | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(promotions)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(promotions.id, id))
      .returning();
    return rows[0];
  }

  async delete(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(promotions)
      .where(eq(promotions.id, id))
      .returning();
    return result.length > 0;
  }

  async activate(id: string, ctx?: TxContext): Promise<Promotion | undefined> {
    return this.update(id, { isActive: true }, ctx);
  }

  async deactivate(
    id: string,
    ctx?: TxContext,
  ): Promise<Promotion | undefined> {
    return this.update(id, { isActive: false }, ctx);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Promotion Usages
  // ─────────────────────────────────────────────────────────────────────────────

  async findUsageById(
    id: string,
    ctx?: TxContext,
  ): Promise<PromotionUsage | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(promotionUsages)
      .where(eq(promotionUsages.id, id));
    return rows[0];
  }

  async findUsagesByPromotionId(
    promotionId: string,
    ctx?: TxContext,
  ): Promise<PromotionUsage[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(promotionUsages)
      .where(eq(promotionUsages.promotionId, promotionId));
  }

  async findUsagesByCustomerId(
    customerId: string,
    ctx?: TxContext,
  ): Promise<PromotionUsage[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(promotionUsages)
      .where(eq(promotionUsages.customerId, customerId));
  }

  async createUsage(
    data: PromotionUsageInsert,
    orgId: string,
    ctx?: TxContext,
  ): Promise<PromotionUsage> {
    const db = this.getDb(ctx);

    // Atomic guard: use INSERT ... SELECT WHERE count < limit to prevent
    // race conditions between concurrent checkouts using the same coupon.
    // A plain count-then-insert has a TOCTOU gap; this single statement
    // ensures the insert only succeeds if the limit has not been reached.
    // Both reads are scoped by organizationId: these are raw/lock queries that
    // bypass the scoped-db proxy, so a promotionId from another tenant must
    // resolve to no row rather than reading/locking a foreign promotion.
    const promo = await db
      .select({ usageLimitTotal: promotions.usageLimitTotal })
      .from(promotions)
      .where(and(eq(promotions.id, data.promotionId), eq(promotions.organizationId, orgId)));

    const limit = promo[0]?.usageLimitTotal;

    if (limit != null) {
      // Atomic guard: lock the promotion row and check usage count in the
      // same statement sequence. This prevents two concurrent checkouts
      // from both passing the count check (TOCTOU race).
      //
      // SELECT ... FOR UPDATE acquires a row-level lock that serializes
      // concurrent callers. If the caller is already inside a transaction
      // (ctx.tx), the lock is held until that transaction commits.
      await db.execute(
        sql`SELECT id FROM promotions WHERE id = ${data.promotionId} AND organization_id = ${orgId} FOR UPDATE`,
      );

      const currentCount = await this.countUsages(data.promotionId, ctx);
      if (currentCount >= limit) {
        throw new Error(`Promotion usage limit reached (${currentCount}/${limit})`);
      }

      const rows = await db.insert(promotionUsages).values(data).returning();
      return rows[0]!;
    }

    const rows = await db.insert(promotionUsages).values(data).returning();
    return rows[0]!;
  }

  async countUsages(promotionId: string, ctx?: TxContext): Promise<number> {
    const db = this.getDb(ctx);
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(promotionUsages)
      .where(eq(promotionUsages.promotionId, promotionId));
    return result[0]?.count ?? 0;
  }

  async countUsagesByCustomer(
    promotionId: string,
    customerId: string,
    ctx?: TxContext,
  ): Promise<number> {
    const db = this.getDb(ctx);
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(promotionUsages)
      .where(
        and(
          eq(promotionUsages.promotionId, promotionId),
          eq(promotionUsages.customerId, customerId),
        ),
      );
    return result[0]?.count ?? 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Validation Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  async isUsageLimitReached(
    orgId: string,
    promotionId: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const promotion = await this.findById(orgId, promotionId, ctx);
    if (!promotion || promotion.usageLimitTotal === null) {
      return false;
    }
    const count = await this.countUsages(promotionId, ctx);
    return count >= promotion.usageLimitTotal;
  }

  async isCustomerUsageLimitReached(
    orgId: string,
    promotionId: string,
    customerId: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const promotion = await this.findById(orgId, promotionId, ctx);
    if (!promotion || promotion.usageLimitPerCustomer === null) {
      return false;
    }
    const count = await this.countUsagesByCustomer(
      promotionId,
      customerId,
      ctx,
    );
    return count >= promotion.usageLimitPerCustomer;
  }

  async isPromotionValid(
    orgId: string,
    promotionId: string,
    customerId?: string,
    ctx?: TxContext,
  ): Promise<{ valid: boolean; reason?: string }> {
    const promotion = await this.findById(orgId, promotionId, ctx);

    if (!promotion) {
      return { valid: false, reason: "Promotion not found" };
    }

    if (!promotion.isActive) {
      return { valid: false, reason: "Promotion is not active" };
    }

    const now = new Date();
    if (promotion.validFrom && promotion.validFrom > now) {
      return { valid: false, reason: "Promotion has not started yet" };
    }

    if (promotion.validUntil && promotion.validUntil < now) {
      return { valid: false, reason: "Promotion has expired" };
    }

    if (await this.isUsageLimitReached(orgId, promotionId, ctx)) {
      return { valid: false, reason: "Promotion usage limit reached" };
    }

    if (
      customerId &&
      (await this.isCustomerUsageLimitReached(orgId, promotionId, customerId, ctx))
    ) {
      return { valid: false, reason: "Customer usage limit reached" };
    }

    return { valid: true };
  }
}
