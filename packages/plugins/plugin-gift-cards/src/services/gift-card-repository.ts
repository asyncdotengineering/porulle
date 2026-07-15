import { eq, desc, and } from "@porulle/core/drizzle";
import { giftCards, giftCardTransactions } from "../schema.js";
import type { Db, GiftCard, GiftCardInsert, GiftCardTransaction, GiftCardStatus, TransactionType } from "../types.js";

export class GiftCardRepository {
  constructor(private db: Db) {}

  private getDb(ctx?: { tx?: Db }): Db {
    return ctx?.tx ?? this.db;
  }

  // ─── Gift Card CRUD ─────────────────────────────────────────────────

  async create(data: GiftCardInsert, ctx?: { tx?: Db }): Promise<GiftCard> {
    const rows = await this.getDb(ctx)
      .insert(giftCards)
      .values(data)
      .returning();
    return rows[0]!;
  }

  async findById(orgId: string, id: string, ctx?: { tx?: Db }): Promise<GiftCard | undefined> {
    const rows = await this.getDb(ctx)
      .select()
      .from(giftCards)
      .where(and(eq(giftCards.id, id), eq(giftCards.organizationId, orgId)));
    return rows[0];
  }

  async findByCode(orgId: string, code: string, ctx?: { tx?: Db }): Promise<GiftCard | undefined> {
    const conditions = [eq(giftCards.code, code)];
    // "_any" is the public bearer-token lookup (check-balance): a gift-card code
    // is org-agnostic by design. Admin id-based lookups stay strictly org-scoped.
    if (orgId !== "_any") conditions.push(eq(giftCards.organizationId, orgId));
    const rows = await this.getDb(ctx)
      .select()
      .from(giftCards)
      .where(and(...conditions));
    return rows[0];
  }

  async list(
    orgId: string,
    filters?: { status?: GiftCardStatus; purchaserId?: string },
    ctx?: { tx?: Db },
  ): Promise<GiftCard[]> {
    const conditions = [eq(giftCards.organizationId, orgId)];
    if (filters?.status) conditions.push(eq(giftCards.status, filters.status));
    if (filters?.purchaserId) conditions.push(eq(giftCards.purchaserId, filters.purchaserId));

    return this.getDb(ctx)
      .select()
      .from(giftCards)
      .where(and(...conditions))
      .orderBy(desc(giftCards.createdAt));
  }

  async disable(orgId: string, id: string, ctx?: { tx?: Db }): Promise<GiftCard | undefined> {
    const rows = await this.getDb(ctx)
      .update(giftCards)
      .set({ status: "disabled" as const, updatedAt: new Date() })
      .where(and(eq(giftCards.id, id), eq(giftCards.organizationId, orgId)))
      .returning();
    return rows[0];
  }

  // ─── SELECT FOR UPDATE (Concurrency-Safe Balance Operations) ───────

  async findByCodeForUpdate(orgId: string, code: string, tx: Db): Promise<GiftCard | undefined> {
    const rows = await tx
      .select()
      .from(giftCards)
      .where(and(eq(giftCards.code, code), eq(giftCards.organizationId, orgId)))
      .for("update");
    return rows[0];
  }

  async findByIdForUpdate(orgId: string, id: string, tx: Db): Promise<GiftCard | undefined> {
    const rows = await tx
      .select()
      .from(giftCards)
      .where(and(eq(giftCards.id, id), eq(giftCards.organizationId, orgId)))
      .for("update");
    return rows[0];
  }

  async updateBalance(
    orgId: string,
    id: string,
    balance: number,
    status: GiftCardStatus,
    currentVersion: number,
    tx: Db,
  ): Promise<GiftCard> {
    const rows = await tx
      .update(giftCards)
      .set({
        balance,
        status,
        version: currentVersion + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(giftCards.id, id), eq(giftCards.organizationId, orgId)))
      .returning();
    return rows[0]!;
  }

  async adjustBalance(
    orgId: string,
    id: string,
    delta: number,
    tx: Db,
  ): Promise<GiftCard> {
    const card = await this.findByIdForUpdate(orgId, id, tx);
    if (!card) throw new Error("Gift card not found");

    const newBalance = Math.max(0, Math.min(card.initialAmount, card.balance + delta));
    const newStatus: GiftCardStatus = newBalance === 0 ? "exhausted" : "active";

    return this.updateBalance(orgId, id, newBalance, newStatus, card.version, tx);
  }

  // ─── Transactions ───────────────────────────────────────────────────

  async recordTransaction(
    data: {
      giftCardId: string;
      type: TransactionType;
      amount: number;
      balanceAfter: number;
      orderId?: string;
      note?: string;
    },
    ctx?: { tx?: Db },
  ): Promise<GiftCardTransaction> {
    const rows = await this.getDb(ctx)
      .insert(giftCardTransactions)
      .values(data)
      .returning();
    return rows[0]!;
  }

  async listTransactions(
    giftCardId: string,
    ctx?: { tx?: Db },
  ): Promise<GiftCardTransaction[]> {
    return this.getDb(ctx)
      .select()
      .from(giftCardTransactions)
      .where(eq(giftCardTransactions.giftCardId, giftCardId))
      .orderBy(desc(giftCardTransactions.createdAt));
  }

  async findTransactionsByOrderId(
    orderId: string,
    ctx?: { tx?: Db },
  ): Promise<GiftCardTransaction[]> {
    return this.getDb(ctx)
      .select()
      .from(giftCardTransactions)
      .where(eq(giftCardTransactions.orderId, orderId))
      .orderBy(desc(giftCardTransactions.createdAt));
  }
}
