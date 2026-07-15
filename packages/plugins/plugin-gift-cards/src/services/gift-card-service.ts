import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { generateGiftCardCode, normalizeCode } from "../code-generator.js";
import { GiftCardRepository } from "./gift-card-repository.js";
import type {
  Db,
  GiftCard,
  GiftCardDeduction,
  GiftCardPluginOptions,
  GiftCardTransaction,
  GiftCardStatus,
  TransactionType,
} from "../types.js";

export class GiftCardService {
  private repo: GiftCardRepository;
  private transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>;

  constructor(
    db: Db,
    transactionFn: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>,
    private options: Required<GiftCardPluginOptions>,
  ) {
    this.repo = new GiftCardRepository(db);
    this.transaction = transactionFn;
  }

  // ─── Create ──────────────────────────────────────────────────────────

  async create(orgId: string, input: {
    amount: number;
    currency: string;
    purchaserId?: string;
    recipientEmail?: string;
    senderName?: string;
    personalMessage?: string;
    sourceOrderId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PluginResult<GiftCard>> {
    if (input.amount <= 0) {
      return Err("Amount must be positive");
    }
    if (input.amount > this.options.maxBalancePerCard) {
      return Err(`Amount exceeds maximum of ${this.options.maxBalancePerCard}`);
    }

    // Generate unique code with collision retry
    let code: string;
    let attempts = 0;
    do {
      code = normalizeCode(generateGiftCardCode(this.options.codeFormat));
      const existing = await this.repo.findByCode(orgId, code);
      if (!existing) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      return Err("Failed to generate unique code after 10 attempts");
    }

    const expiresAt = this.options.defaultExpiryDays
      ? new Date(Date.now() + this.options.defaultExpiryDays * 24 * 60 * 60 * 1000)
      : undefined;

    const card = await this.repo.create({
      organizationId: orgId,
      code,
      initialAmount: input.amount,
      balance: input.amount,
      currency: input.currency.toUpperCase(),
      purchaserId: input.purchaserId,
      recipientEmail: input.recipientEmail,
      senderName: input.senderName,
      personalMessage: input.personalMessage,
      sourceOrderId: input.sourceOrderId,
      expiresAt,
      metadata: input.metadata ?? {},
    });

    // Record initial credit transaction
    await this.repo.recordTransaction({
      giftCardId: card.id,
      type: "credit" as const,
      amount: input.amount,
      balanceAfter: input.amount,
      note: "Initial load",
    });

    return Ok(card);
  }

  // ─── Query ───────────────────────────────────────────────────────────

  async getById(orgId: string, id: string): Promise<PluginResult<GiftCard>> {
    const card = await this.repo.findById(orgId, id);
    if (!card) return Err("Gift card not found");
    return Ok(card);
  }

  async getByCode(orgId: string, code: string): Promise<PluginResult<GiftCard>> {
    const card = await this.repo.findByCode(orgId, normalizeCode(code));
    if (!card) return Err("Gift card not found");
    return Ok(card);
  }

  async list(orgId: string, filters?: {
    status?: GiftCardStatus;
    purchaserId?: string;
  }): Promise<PluginResult<GiftCard[]>> {
    const cards = await this.repo.list(orgId, filters);
    return Ok(cards);
  }

  async getTransactions(
    orgId: string,
    giftCardId: string,
  ): Promise<PluginResult<GiftCardTransaction[]>> {
    const txns = await this.repo.listTransactions(giftCardId);
    return Ok(txns);
  }

  // ─── Balance Check (Public) ──────────────────────────────────────────

  async checkBalance(orgId: string, code: string): Promise<PluginResult<{
    balance: number;
    currency: string;
    status: string;
  }>> {
    const card = await this.repo.findByCode(orgId, normalizeCode(code));
    if (!card) return Err("Gift card not found");

    return Ok({
      balance: card.balance,
      currency: card.currency,
      status: card.status,
    });
  }

  // ─── Debit (Concurrency-Safe) ────────────────────────────────────────

  /**
   * Debit a gift card balance within a transaction.
   * Uses SELECT FOR UPDATE to prevent double-spend.
   */
  async debitWithLock(
    orgId: string,
    code: string,
    amount: number,
    orderId: string,
    currency: string,
  ): Promise<PluginResult<GiftCardDeduction>> {
    if (amount <= 0) return Err("Debit amount must be positive");

    const result = await this.transaction(async (tx) => {
      const card = await this.repo.findByCodeForUpdate(orgId, normalizeCode(code), tx);
      if (!card) return Err("GIFT_CARD_NOT_FOUND");
      if (card.status === "disabled") return Err("GIFT_CARD_INACTIVE");
      if (card.status === "exhausted") return Err("GIFT_CARD_EXHAUSTED");
      if (card.expiresAt && card.expiresAt < new Date()) return Err("GIFT_CARD_EXPIRED");
      if (card.currency !== currency.toUpperCase()) return Err("CURRENCY_MISMATCH");
      if (card.balance < amount) return Err("INSUFFICIENT_BALANCE");

      const balanceAfter = card.balance - amount;
      const newStatus: GiftCardStatus = balanceAfter === 0 ? "exhausted" : "active";

      await this.repo.updateBalance(orgId, card.id, balanceAfter, newStatus, card.version, tx);
      await this.repo.recordTransaction(
        {
          giftCardId: card.id,
          type: "debit" as const,
          amount,
          balanceAfter,
          orderId,
        },
        { tx },
      );

      return Ok({
        code: card.code,
        giftCardId: card.id,
        amount,
        balanceAfter,
      });
    });

    return result as PluginResult<GiftCardDeduction>;
  }

  // ─── Credit (Concurrency-Safe) ───────────────────────────────────────

  /**
   * Credit a gift card balance (refund/compensation).
   * Uses SELECT FOR UPDATE. Cannot exceed initial_amount.
   */
  async creditWithLock(
    orgId: string,
    code: string,
    amount: number,
    orderId: string,
    note: string,
  ): Promise<PluginResult<{ balanceAfter: number }>> {
    if (amount <= 0) return Err("Credit amount must be positive");

    const result = await this.transaction(async (tx) => {
      const card = await this.repo.findByCodeForUpdate(orgId, normalizeCode(code), tx);
      if (!card) return Err("GIFT_CARD_NOT_FOUND");

      // Cap credit at initial amount (prevent inflation attack)
      const balanceAfter = Math.min(card.initialAmount, card.balance + amount);
      const actualCredit = balanceAfter - card.balance;

      if (actualCredit <= 0) {
        return Ok({ balanceAfter: card.balance });
      }

      const newStatus: GiftCardStatus = balanceAfter > 0 ? "active" : card.status;

      await this.repo.updateBalance(orgId, card.id, balanceAfter, newStatus, card.version, tx);
      await this.repo.recordTransaction(
        {
          giftCardId: card.id,
          type: "refund" as const,
          amount: actualCredit,
          balanceAfter,
          orderId,
          note,
        },
        { tx },
      );

      return Ok({ balanceAfter });
    });

    return result as PluginResult<{ balanceAfter: number }>;
  }

  // ─── Admin Operations ────────────────────────────────────────────────

  async disable(orgId: string, id: string): Promise<PluginResult<GiftCard>> {
    const card = await this.repo.disable(orgId, id);
    if (!card) return Err("Gift card not found");
    return Ok(card);
  }

  async adjust(
    orgId: string,
    id: string,
    delta: number,
    note: string,
  ): Promise<PluginResult<GiftCard>> {
    const result = await this.transaction(async (tx) => {
      const card = await this.repo.findByIdForUpdate(orgId, id, tx);
      if (!card) return Err("Gift card not found");

      const newBalance = Math.max(0, Math.min(card.initialAmount, card.balance + delta));
      const actualDelta = newBalance - card.balance;
      const newStatus: GiftCardStatus = newBalance === 0 ? "exhausted" : "active";

      const updated = await this.repo.updateBalance(
        orgId,
        card.id,
        newBalance,
        newStatus,
        card.version,
        tx,
      );

      if (actualDelta !== 0) {
        const txnType: TransactionType = actualDelta > 0 ? "credit" : "debit";
        await this.repo.recordTransaction(
          {
            giftCardId: card.id,
            type: txnType,
            amount: Math.abs(actualDelta),
            balanceAfter: newBalance,
            note,
          },
          { tx },
        );
      }

      return Ok(updated);
    });

    return result as PluginResult<GiftCard>;
  }
}
