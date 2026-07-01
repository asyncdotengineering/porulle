import { eq, and, asc } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { taxRates } from "../schema.js";

export type TaxRate = typeof taxRates.$inferSelect;
export type TaxRateInsert = typeof taxRates.$inferInsert;

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
}
