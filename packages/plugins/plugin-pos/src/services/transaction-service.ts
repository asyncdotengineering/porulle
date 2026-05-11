import { eq, and, desc, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posTransactions, posPayments, posShifts } from "../schema.js";
import type { Db, Transaction, TransactionInsert } from "../types.js";

export class TransactionService {
  constructor(
    private db: Db,
    private transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>,
  ) {}

  async create(orgId: string, input: {
    shiftId: string;
    terminalId: string;
    operatorId: string;
    cartId: string;
    type?: "sale" | "return" | "exchange";
    customerId?: string;
  }): Promise<PluginResult<Transaction>> {
    // Verify shift is open
    const shifts = await this.db
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.id, input.shiftId), eq(posShifts.status, "open")));
    if (shifts.length === 0) return Err("Shift is not open");

    const receiptNumber = await this.generateReceiptNumber(input.terminalId);

    const rows = await this.db
      .insert(posTransactions)
      .values({
        organizationId: orgId,
        shiftId: input.shiftId,
        terminalId: input.terminalId,
        operatorId: input.operatorId,
        cartId: input.cartId,
        type: input.type ?? "sale",
        status: "open",
        customerId: input.customerId,
        receiptNumber,
      } as TransactionInsert)
      .returning();

    return Ok(rows[0]!);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<Transaction>> {
    const rows = await this.db
      .select()
      .from(posTransactions)
      .where(and(eq(posTransactions.id, id), eq(posTransactions.organizationId, orgId)));

    if (rows.length === 0) return Err("Transaction not found");
    return Ok(rows[0]!);
  }

  async hold(orgId: string, id: string, label: string): Promise<PluginResult<Transaction>> {
    const txnResult = await this.getById(orgId, id);
    if (!txnResult.ok) return txnResult;
    if (txnResult.value.status !== "open") return Err("Only open transactions can be held");

    const rows = await this.db
      .update(posTransactions)
      .set({ status: "held", holdLabel: label, updatedAt: new Date() })
      .where(eq(posTransactions.id, id))
      .returning();

    return Ok(rows[0]!);
  }

  async recall(orgId: string, id: string): Promise<PluginResult<Transaction>> {
    const txnResult = await this.getById(orgId, id);
    if (!txnResult.ok) return txnResult;
    if (txnResult.value.status !== "held") return Err("Only held transactions can be recalled");

    const rows = await this.db
      .update(posTransactions)
      .set({ status: "open", holdLabel: null, updatedAt: new Date() })
      .where(eq(posTransactions.id, id))
      .returning();

    return Ok(rows[0]!);
  }

  async listHeld(orgId: string, terminalId: string): Promise<PluginResult<Transaction[]>> {
    const rows = await this.db
      .select()
      .from(posTransactions)
      .where(and(
        eq(posTransactions.organizationId, orgId),
        eq(posTransactions.terminalId, terminalId),
        eq(posTransactions.status, "held"),
      ))
      .orderBy(desc(posTransactions.createdAt));

    return Ok(rows);
  }

  async void(orgId: string, id: string, reason: string): Promise<PluginResult<Transaction>> {
    const result = await this.transaction(async (tx) => {
      const txns = await tx
        .select()
        .from(posTransactions)
        .where(and(eq(posTransactions.id, id), eq(posTransactions.organizationId, orgId)))
        .for("update");

      if (txns.length === 0) return Err("Transaction not found");
      const txn = txns[0]!;

      if (txn.status === "completed") return Err("Cannot void a completed transaction");
      if (txn.status === "voided") return Err("Transaction is already voided");

      const updated = await tx
        .update(posTransactions)
        .set({ status: "voided", voidReason: reason, updatedAt: new Date() })
        .where(eq(posTransactions.id, id))
        .returning();

      // Increment void count on shift
      await tx
        .update(posShifts)
        .set({ voidsCount: sql`${posShifts.voidsCount} + 1`, updatedAt: new Date() })
        .where(eq(posShifts.id, txn.shiftId));

      return Ok(updated[0]!);
    });

    return result as PluginResult<Transaction>;
  }

  async setCustomer(orgId: string, id: string, customerId: string): Promise<PluginResult<Transaction>> {
    const txnResult = await this.getById(orgId, id);
    if (!txnResult.ok) return txnResult;
    if (txnResult.value.status !== "open") return Err("Can only set customer on open transactions");

    const rows = await this.db
      .update(posTransactions)
      .set({ customerId, updatedAt: new Date() })
      .where(eq(posTransactions.id, id))
      .returning();

    return Ok(rows[0]!);
  }

  async updateTotals(id: string, totals: {
    subtotal: number;
    taxTotal: number;
    total: number;
    discountTotal: number;
  }): Promise<void> {
    await this.db
      .update(posTransactions)
      .set({ ...totals, updatedAt: new Date() })
      .where(eq(posTransactions.id, id));
  }

  async complete(id: string, orderId: string | null): Promise<PluginResult<Transaction>> {
    const result = await this.transaction(async (tx) => {
      // Lock and verify transaction is in a completable state
      const existing = await tx
        .select()
        .from(posTransactions)
        .where(eq(posTransactions.id, id))
        .for("update");

      if (existing.length === 0) return Err("Transaction not found");
      const current = existing[0]!;
      if (current.status === "completed") return Err("Transaction is already completed");
      if (current.status === "voided") return Err("Cannot complete a voided transaction");
      if (current.status !== "open") return Err(`Cannot complete transaction in '${current.status}' status`);

      // Sum collected payments to derive transaction total
      const paymentRows = await tx
        .select({
          total: sql<number>`COALESCE(SUM(${posPayments.amount} - ${posPayments.changeGiven}), 0)`.as("total"),
        })
        .from(posPayments)
        .where(and(
          eq(posPayments.transactionId, id),
          eq(posPayments.status, "collected"),
        ));
      const paymentTotal = Number(paymentRows[0]?.total ?? 0);

      const rows = await tx
        .update(posTransactions)
        .set({
          status: "completed",
          subtotal: paymentTotal,
          total: paymentTotal,
          ...(orderId != null ? { orderId } : {}),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(posTransactions.id, id))
        .returning();

      if (rows.length === 0) return Err("Transaction not found");
      const txn = rows[0]!;

      // Update shift sales counters
      if (txn.type === "sale" && paymentTotal > 0) {
        await tx
          .update(posShifts)
          .set({
            salesCount: sql`${posShifts.salesCount} + 1`,
            salesTotal: sql`${posShifts.salesTotal} + ${paymentTotal}`,
            updatedAt: new Date(),
          })
          .where(eq(posShifts.id, txn.shiftId));
      }

      return Ok(txn);
    });

    return result as PluginResult<Transaction>;
  }

  // ─── Receipt Number Generation ─────────────────────────────────────
  // Sequential per terminal per day: {terminal_code}-{sequence}

  private async generateReceiptNumber(terminalId: string): Promise<string> {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfDayISO = startOfDay.toISOString();

    // Get terminal code
    const { posTerminals } = await import("../schema.js");
    const terminals = await this.db
      .select({ code: posTerminals.code })
      .from(posTerminals)
      .where(eq(posTerminals.id, terminalId));

    const terminalCode = terminals[0]?.code ?? "POS";

    // Count today's transactions for this terminal
    const countRows = await this.db
      .select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(posTransactions)
      .where(and(
        eq(posTransactions.terminalId, terminalId),
        sql`${posTransactions.createdAt} >= ${startOfDayISO}::timestamptz`,
      ));

    const seq = Number(countRows[0]?.count ?? 0) + 1;
    return `${terminalCode}-${String(seq).padStart(4, "0")}`;
  }
}
