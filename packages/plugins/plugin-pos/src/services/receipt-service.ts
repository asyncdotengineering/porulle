import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err, escapeHtml, formatAmount } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posTransactions, posPayments } from "../schema.js";
import type { Db, Transaction, Payment } from "../types.js";

export interface ReceiptData {
  receiptNumber: string;
  transactionId: string;
  terminalCode: string;
  operatorName: string;
  timestamp: Date;
  lineItems: Array<{
    title: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    notes?: string | null;
  }>;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  payments: Array<{
    method: string;
    amount: number;
    changeGiven: number;
    reference?: string | null;
  }>;
  changeDue: number;
  customerId?: string | null;
  currency: string;
}

export class ReceiptService {
  constructor(
    private db: Db,
    private services: Record<string, unknown>,
  ) {}

  /**
   * Assemble full receipt data for a completed transaction.
   */
  async getReceipt(orgId: string, transactionId: string): Promise<PluginResult<ReceiptData>> {
    // Get transaction
    const txns = await this.db
      .select()
      .from(posTransactions)
      .where(and(
        eq(posTransactions.id, transactionId),
        eq(posTransactions.organizationId, orgId),
      ));

    if (txns.length === 0) return Err("Transaction not found");
    const txn = txns[0]!;

    if (txn.status !== "completed" && txn.status !== "voided") {
      return Err("Receipt is only available for completed or voided transactions");
    }

    // Get terminal code
    const { posTerminals } = await import("../schema.js");
    const terminals = await this.db
      .select({ code: posTerminals.code, name: posTerminals.name })
      .from(posTerminals)
      .where(eq(posTerminals.id, txn.terminalId));

    const terminalCode = terminals[0]?.code ?? "POS";

    // Get payments
    const payments = await this.db
      .select()
      .from(posPayments)
      .where(eq(posPayments.transactionId, transactionId));

    // Get order line items from core
    let lineItems: ReceiptData["lineItems"] = [];
    let currency = "USD";
    if (txn.orderId) {
      const orders = this.services.orders as {
        getById: (id: string, actor: unknown) => Promise<{ ok: boolean; value?: { currency?: string; lineItems?: Array<{ title?: string; quantity: number; unitPrice?: number; totalPrice?: number }> } }>;
      } | undefined;

      if (orders) {
        const orderResult = await orders.getById(txn.orderId, null);
        if (orderResult.ok && orderResult.value) {
          currency = orderResult.value.currency ?? currency;
          if (orderResult.value.lineItems) {
            lineItems = orderResult.value.lineItems.map((li) => ({
              title: li.title ?? "Item",
              quantity: li.quantity,
              unitPrice: li.unitPrice ?? 0,
              totalPrice: li.totalPrice ?? 0,
            }));
          }
        }
      }
    }

    // Calculate change due
    const totalPaid = payments
      .filter((p) => p.status === "collected")
      .reduce((sum, p) => sum + p.amount, 0);
    const changeDue = payments
      .filter((p) => p.status === "collected")
      .reduce((sum, p) => sum + p.changeGiven, 0);

    return Ok({
      receiptNumber: txn.receiptNumber,
      transactionId: txn.id,
      terminalCode,
      operatorName: txn.operatorId,
      timestamp: txn.completedAt ?? txn.createdAt,
      lineItems,
      subtotal: txn.subtotal,
      discountTotal: txn.discountTotal,
      taxTotal: txn.taxTotal,
      total: txn.total,
      payments: payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        changeGiven: p.changeGiven,
        reference: p.reference,
      })),
      changeDue,
      customerId: txn.customerId,
      currency,
    });
  }

  /**
   * Send receipt via email (delegates to email service).
   */
  async emailReceipt(orgId: string, transactionId: string, email: string): Promise<PluginResult<{ sent: boolean }>> {
    const receiptResult = await this.getReceipt(orgId, transactionId);
    if (!receiptResult.ok) return receiptResult;

    const emailService = this.services.email as {
      send?: (opts: { to: string; subject: string; html: string }) => Promise<void>;
    } | undefined;

    if (!emailService?.send) {
      return Err("Email service not configured");
    }

    await emailService.send({
      to: email,
      subject: `Receipt ${receiptResult.value.receiptNumber}`,
      html: this.formatReceiptHtml(receiptResult.value, receiptResult.value.currency),
    });

    return Ok({ sent: true });
  }

  private formatReceiptHtml(receipt: ReceiptData, currency = "USD"): string {
    const fmt = (minor: number) => formatAmount(minor, currency);
    const lines = receipt.lineItems
      .map((li) => `<tr><td>${escapeHtml(li.title)}</td><td>${li.quantity}</td><td>${fmt(li.unitPrice)}</td><td>${fmt(li.totalPrice)}</td></tr>`)
      .join("");

    return `
      <h2>Receipt ${escapeHtml(receipt.receiptNumber)}</h2>
      <p>Date: ${receipt.timestamp.toISOString()}</p>
      <table>
        <tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr>
        ${lines}
      </table>
      <p>Subtotal: ${fmt(receipt.subtotal)}</p>
      ${receipt.discountTotal > 0 ? `<p>Discount: -${fmt(receipt.discountTotal)}</p>` : ""}
      <p>Tax: ${fmt(receipt.taxTotal)}</p>
      <p><strong>Total: ${fmt(receipt.total)}</strong></p>
      ${receipt.payments.map((p) => `<p>${escapeHtml(p.method)}: ${fmt(p.amount)}</p>`).join("")}
      ${receipt.changeDue > 0 ? `<p>Change: ${fmt(receipt.changeDue)}</p>` : ""}
    `;
  }
}
