import { and, eq, sql } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { invoiceSequences, orderDocuments } from "../schema.js";

export type OrderDocument = typeof orderDocuments.$inferSelect;

/**
 * Persistence for fiscal sequences and issued documents (issue #47).
 */
export class DocumentsRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  /**
   * Atomically allocates the next sequence value for (org, series).
   * Single upsert-returning statement — safe under concurrency.
   */
  async allocate(orgId: string, series: string, ctx?: TxContext): Promise<number> {
    const db = this.getDb(ctx);
    const rows = await db
      .insert(invoiceSequences)
      .values({ organizationId: orgId, series, nextValue: 2 })
      .onConflictDoUpdate({
        target: [invoiceSequences.organizationId, invoiceSequences.series],
        set: {
          nextValue: sql`${invoiceSequences.nextValue} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning({ nextValue: invoiceSequences.nextValue });
    // nextValue is post-increment; the allocated number is one less.
    return rows[0]!.nextValue - 1;
  }

  async findDocument(
    orgId: string,
    orderId: string,
    type: string,
    ctx?: TxContext,
  ): Promise<OrderDocument | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(orderDocuments)
      .where(and(
        eq(orderDocuments.organizationId, orgId),
        eq(orderDocuments.orderId, orderId),
        eq(orderDocuments.type, type),
      ));
    return rows[0];
  }

  async createDocument(
    data: { organizationId: string; orderId: string; type: string; documentNumber: string },
    ctx?: TxContext,
  ): Promise<OrderDocument> {
    const db = this.getDb(ctx);
    const rows = await db.insert(orderDocuments).values(data).returning();
    return rows[0]!;
  }
}
