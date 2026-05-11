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

  async findById(id: string, ctx?: { tx?: Db }): Promise<GiftCard | undefined> {
    const rows = await this.getDb(ctx)
      .select()
      .from(giftCards)
      .where(eq(giftCards.id, id));
    return rows[0];
  }

  async findByCode(code: string, ctx?: { tx?: Db }): Promise<GiftCard | undefined> {
    const rows = await this.getDb(ctx)
      .select()
      .from(giftCards)
      .where(eq(giftCards.code, code));
    return rows[0];
  }

  async list(
    filters?: { status?: GiftCardStatus; purchaserId?: string },
    ctx?: { tx?: Db },
  ): Promise<GiftCard[]> {
    const conditions = [];
    if (filters?.status) conditions.push(eq(giftCards.status, filters.status));
    if (filters?.purchaserId) conditions.push(eq(giftCards.purchaserId, filters.purchaserId));

    return this.getDb(ctx)
      .select()
      .from(giftCards)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(giftCards.createdAt));
  }

  async disable(id: string, ctx?: { tx?: Db }): Promise<GiftCard | undefined> {
    const rows = await this.getDb(ctx)
      .update(giftCards)
      .set({ status: "disabled" as const, updatedAt: new Date() })
      .where(eq(giftCards.id, id))
      .returning();
    return rows[0];
  }

  // ─── SELECT FOR UPDATE (Concurrency-Safe Balance Operations) ───────

  async findByCodeForUpdate(code: string, tx: Db): Promise<GiftCard | undefined> {
    const rows = await tx
      .select()
      .from(giftCards)
      .where(eq(giftCards.code, code))
      .for("update");
    return rows[0];
  }

  async findByIdForUpdate(id: string, tx: Db): Promise<GiftCard | undefined> {
    const rows = await tx
      .select()
      .from(giftCards)
      .where(eq(giftCards.id, id))
      .for("update");
    return rows[0];
  }

  async updateBalance(
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
      .where(eq(giftCards.id, id))
      .returning();
    return rows[0]!;
  }

  async adjustBalance(
    id: string,
    delta: number,
    tx: Db,
  ): Promise<GiftCard> {
    const card = await this.findByIdForUpdate(id, tx);
    if (!card) throw new Error("Gift card not found");

    const newBalance = Math.max(0, Math.min(card.initialAmount, card.balance + delta));
    const newStatus: GiftCardStatus = newBalance === 0 ? "exhausted" : "active";

    return this.updateBalance(id, newBalance, newStatus, card.version, tx);
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
