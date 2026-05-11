import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posPayments, posTransactions, posShifts } from "../schema.js";
import type { Db, Payment, Transaction } from "../types.js";

export class PaymentService {
  constructor(
    private db: Db,
    private transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>,
  ) {}

  /**
   * Add a payment to a transaction. Does NOT finalize.
   * Supports split payment (multiple calls per transaction).
   */
  async addPayment(orgId: string, transactionId: string, input: {
    method: "cash" | "card" | "gift_card" | "store_credit" | "other";
    amount: number;
    changeGiven?: number;
    reference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PluginResult<Payment>> {
    if (input.amount <= 0) return Err("Payment amount must be positive");

    // Verify transaction is open
    const txns = await this.db
      .select()
      .from(posTransactions)
      .where(and(
        eq(posTransactions.id, transactionId),
        eq(posTransactions.organizationId, orgId),
      ));

    if (txns.length === 0) return Err("Transaction not found");
    const txn = txns[0]!;
    if (txn.status !== "open") return Err("Transaction is not open");

    const rows = await this.db
      .insert(posPayments)
      .values({
        transactionId,
        method: input.method,
        amount: input.amount,
        changeGiven: input.changeGiven ?? 0,
        reference: input.reference,
        status: "collected",
        processedAt: new Date(),
        metadata: input.metadata ?? {},
      })
      .returning();

    return Ok(rows[0]!);
  }

  /**
   * Get total payments collected for a transaction.
   */
  async getPaymentTotal(transactionId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${posPayments.amount} - ${posPayments.changeGiven}), 0)`.as("total"),
      })
      .from(posPayments)
      .where(and(
        eq(posPayments.transactionId, transactionId),
        eq(posPayments.status, "collected"),
      ));

    return Number(rows[0]?.total ?? 0);
  }

  /**
   * List all payments for a transaction.
   */
  async listPayments(transactionId: string): Promise<PluginResult<Payment[]>> {
    const rows = await this.db
      .select()
      .from(posPayments)
      .where(eq(posPayments.transactionId, transactionId));

    return Ok(rows);
  }

  /**
   * Validate that total payments cover the transaction total, then return
   * the transaction details needed for checkout.
   */
  async validateForCompletion(orgId: string, transactionId: string): Promise<PluginResult<{
    transaction: Transaction;
    payments: Payment[];
    totalPaid: number;
  }>> {
    const txns = await this.db
      .select()
      .from(posTransactions)
      .where(and(
        eq(posTransactions.id, transactionId),
        eq(posTransactions.organizationId, orgId),
      ));

    if (txns.length === 0) return Err("Transaction not found");
    const txn = txns[0]!;
    if (txn.status !== "open") return Err(`Transaction is ${txn.status}, not open`);

    const payments = await this.db
      .select()
      .from(posPayments)
      .where(and(
        eq(posPayments.transactionId, transactionId),
        eq(posPayments.status, "collected"),
      ));

    const totalPaid = payments.reduce((sum, p) => sum + p.amount - p.changeGiven, 0);

    if (txn.total > 0 && totalPaid < txn.total) {
      return Err(`Insufficient payment: ${totalPaid} paid, ${txn.total} required`);
    }

    return Ok({ transaction: txn, payments, totalPaid });
  }

  /**
   * Mark payments as refunded for a transaction.
   */
  async refundPayments(transactionId: string, tx?: Db): Promise<void> {
    const db = tx ?? this.db;
    await db
      .update(posPayments)
      .set({ status: "refunded" })
      .where(eq(posPayments.transactionId, transactionId));
  }
}
