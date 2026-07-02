import { eq, and, asc, inArray } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { sellableEntities, variants } from "../../catalog/schema.js";
import { taxClasses, taxRates } from "../schema.js";

export type TaxRate = typeof taxRates.$inferSelect;
export type TaxRateInsert = typeof taxRates.$inferInsert;
export type TaxClass = typeof taxClasses.$inferSelect;
export type TaxClassInsert = typeof taxClasses.$inferInsert;

/**
 * Persistence for runtime tax rates (issue #45).
 */
export class TaxRatesRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  async findById(orgId: string, id: string, ctx?: TxContext): Promise<TaxRate | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.organizationId, orgId), eq(taxRates.id, id)));
    return rows[0];
  }

  async findAll(orgId: string, ctx?: TxContext): Promise<TaxRate[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(taxRates)
      .where(eq(taxRates.organizationId, orgId))
      .orderBy(asc(taxRates.priority));
  }

  async findActive(orgId: string, ctx?: TxContext): Promise<TaxRate[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.organizationId, orgId), eq(taxRates.isActive, true)))
      .orderBy(asc(taxRates.priority));
  }

  async create(data: TaxRateInsert, ctx?: TxContext): Promise<TaxRate> {
    const db = this.getDb(ctx);
    const rows = await db.insert(taxRates).values(data).returning();
    return rows[0]!;
  }

  async update(
    id: string,
    data: Partial<Omit<TaxRateInsert, "id" | "organizationId">>,
    ctx?: TxContext,
  ): Promise<TaxRate | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(taxRates)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(taxRates.id, id))
      .returning();
    return rows[0];
  }

  async delete(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const rows = await db.delete(taxRates).where(eq(taxRates.id, id)).returning();
    return rows.length > 0;
  }

  // ── Product tax classes (issue #57) ─────────────────────────────────────

  async findActiveClasses(orgId: string, ctx?: TxContext): Promise<TaxClass[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(taxClasses)
      .where(and(eq(taxClasses.organizationId, orgId), eq(taxClasses.isActive, true)))
      .orderBy(asc(taxClasses.name));
  }

  async findAllClasses(orgId: string, ctx?: TxContext): Promise<TaxClass[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(taxClasses)
      .where(eq(taxClasses.organizationId, orgId))
      .orderBy(asc(taxClasses.name));
  }

  async findClassById(orgId: string, id: string, ctx?: TxContext): Promise<TaxClass | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(taxClasses)
      .where(and(eq(taxClasses.organizationId, orgId), eq(taxClasses.id, id)));
    return rows[0];
  }

  async createClass(data: TaxClassInsert, ctx?: TxContext): Promise<TaxClass> {
    const db = this.getDb(ctx);
    const rows = await db.insert(taxClasses).values(data).returning();
    return rows[0]!;
  }

  async updateClass(
    id: string,
    data: Partial<Omit<TaxClassInsert, "id" | "organizationId">>,
    ctx?: TxContext,
  ): Promise<TaxClass | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(taxClasses)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(taxClasses.id, id))
      .returning();
    return rows[0];
  }

  async deleteClass(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const rows = await db.delete(taxClasses).where(eq(taxClasses.id, id)).returning();
    return rows.length > 0;
  }

  async clearDefaultClass(orgId: string, ctx?: TxContext): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .update(taxClasses)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(taxClasses.organizationId, orgId), eq(taxClasses.isDefault, true)));
  }

  /**
   * Resolves the taxClass for catalog references: variant.taxClass overrides
   * entity.taxClass. Returns maps keyed by id so callers can pick
   * variant-first.
   */
  async resolveCatalogTaxClasses(
    refs: Array<{ entityId: string; variantId?: string | undefined }>,
    ctx?: TxContext,
  ): Promise<{ byEntity: Map<string, string | null>; byVariant: Map<string, string | null> }> {
    const db = this.getDb(ctx);
    const entityIds = [...new Set(refs.map((r) => r.entityId))];
    const variantIds = [...new Set(refs.flatMap((r) => (r.variantId ? [r.variantId] : [])))];

    const byEntity = new Map<string, string | null>();
    const byVariant = new Map<string, string | null>();
    if (entityIds.length > 0) {
      const rows = await db
        .select({ id: sellableEntities.id, taxClass: sellableEntities.taxClass })
        .from(sellableEntities)
        .where(inArray(sellableEntities.id, entityIds));
      for (const row of rows) byEntity.set(row.id, row.taxClass);
    }
    if (variantIds.length > 0) {
      const rows = await db
        .select({ id: variants.id, taxClass: variants.taxClass })
        .from(variants)
        .where(inArray(variants.id, variantIds));
      for (const row of rows) byVariant.set(row.id, row.taxClass);
    }
    return { byEntity, byVariant };
  }
}
