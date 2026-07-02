import { eq } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posTransactions } from "../schema.js";
import type { Db, Transaction } from "../types.js";
import type { ReturnService } from "./return-service.js";
import type { TransactionService } from "./transaction-service.js";

/**
 * Exchanges (issue #53): return line items + create a replacement order +
 * settle the difference, in one call.
 *
 * The financially-critical half — the line-level refund on the original
 * order (core issue #52 primitives: refundable-quantity enforcement, daily
 * cap, audited ledger) and the replacement order creation — runs inside ONE
 * database transaction, so a failure in either leaves no money moved and no
 * order created. The POS bookkeeping rows (transaction, return items) are
 * written after commit and cross-linked for audit.
 */

export interface ExchangeInput {
  shiftId: string;
  terminalId: string;
  originalOrderId: string;
  currency?: string | undefined;
  customerId?: string | undefined;
  returnItems: Array<{
    originalLineItemId: string;
    quantity: number;
    reason: "defective" | "wrong_item" | "changed_mind" | "other";
  }>;
  replacementItems: Array<{
    entityId: string;
    variantId?: string | undefined;
    sku?: string | undefined;
    title: string;
    quantity: number;
    unitPrice: number;
    taxAmount?: number | undefined;
  }>;
}

interface CoreOrdersService {
  refundLines(
    orderId: string,
    input: { lines: Array<{ lineItemId: string; quantity: number }>; reason?: string },
    actor: unknown,
    ctx?: unknown,
  ): Promise<{ ok: boolean; value?: { refund: { id: string; amount: number; lines: Array<{ lineItemId: string; quantity: number; amount: number }> } }; error?: { message?: string } }>;
  create(
    input: Record<string, unknown>,
    actor: unknown,
    ctx?: unknown,
  ): Promise<{ ok: boolean; value?: { id: string; grandTotal: number }; error?: { message?: string } }>;
}

export class ExchangeService {
  constructor(
    private db: Db,
    private services: Record<string, unknown>,
    private transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>,
    private transactionService: TransactionService,
    private returnService: ReturnService,
  ) {}

  async exchange(
    orgId: string,
    input: ExchangeInput,
    actor: { userId: string } & Record<string, unknown>,
  ): Promise<PluginResult<{
    transaction: Transaction;
    refundId: string;
    returnTotal: number;
    replacementOrderId: string;
    replacementTotal: number;
    netDelta: number;
  }>> {
    if (input.returnItems.length === 0) return Err("At least one return item is required");
    if (input.replacementItems.length === 0) return Err("At least one replacement item is required");

    const orders = this.services.orders as CoreOrdersService;
    const currency = input.currency ?? "USD";

    const subtotal = input.replacementItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const taxTotal = input.replacementItems.reduce((sum, i) => sum + (i.taxAmount ?? 0), 0);
    const replacementTotal = subtotal + taxTotal;

    // Atomic core half: refund the returned lines + create the replacement.
    const core = await this.transaction(async (tx) => {
      const txCtx = { tx, actor };
      const refund = await orders.refundLines(
        input.originalOrderId,
        {
          lines: input.returnItems.map((item) => ({
            lineItemId: item.originalLineItemId,
            quantity: item.quantity,
          })),
          reason: "exchange",
        },
        actor,
        txCtx,
      );
      if (!refund.ok || !refund.value) {
        throw new Error(refund.error?.message ?? "Exchange refund failed");
      }

      const replacement = await orders.create(
        {
          currency,
          subtotal,
          taxTotal,
          shippingTotal: 0,
          grandTotal: replacementTotal,
          ...(input.customerId ? { customerId: input.customerId } : {}),
          metadata: {
            exchange: {
              originalOrderId: input.originalOrderId,
              refundId: refund.value.refund.id,
            },
          },
          lineItems: input.replacementItems.map((item) => ({
            entityId: item.entityId,
            entityType: "product",
            ...(item.variantId ? { variantId: item.variantId } : {}),
            ...(item.sku ? { sku: item.sku } : {}),
            title: item.title,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: item.unitPrice * item.quantity,
            taxAmount: item.taxAmount ?? 0,
          })),
        },
        actor,
        txCtx,
      );
      if (!replacement.ok || !replacement.value) {
        throw new Error(replacement.error?.message ?? "Replacement order creation failed");
      }
      return { refund: refund.value.refund, replacementOrder: replacement.value };
    }).catch((error: unknown) => error as Error);

    if (core instanceof Error) return Err(core.message);

    const returnTotal = core.refund.amount;
    const netDelta = replacementTotal - returnTotal;

    // POS bookkeeping (post-commit): cart + exchange transaction + return rows.
    const cart = this.services.cart as {
      create(input: Record<string, unknown>, actor: unknown): Promise<{ ok: boolean; value?: { id: string } }>;
    };
    const cartResult = await cart.create(
      { currency, metadata: { posExchange: true, originalOrderId: input.originalOrderId } },
      actor,
    );
    if (!cartResult.ok || !cartResult.value) return Err("Failed to create cart for exchange");

    const txnResult = await this.transactionService.create(orgId, {
      shiftId: input.shiftId,
      terminalId: input.terminalId,
      operatorId: actor.userId,
      cartId: cartResult.value.id,
      type: "exchange",
      ...(input.customerId ? { customerId: input.customerId } : {}),
    });
    if (!txnResult.ok) return Err(txnResult.error);
    const txn = txnResult.value;

    await this.returnService.addReturnItems(
      txn.id,
      input.returnItems.map((item) => ({
        originalOrderId: input.originalOrderId,
        originalLineItemId: item.originalLineItemId,
        quantity: item.quantity,
        reason: item.reason,
        refundAmount:
          core.refund.lines.find((l) => l.lineItemId === item.originalLineItemId)?.amount ?? 0,
      })),
    );

    await this.transactionService.updateTotals(txn.id, {
      subtotal,
      taxTotal,
      total: netDelta,
      discountTotal: 0,
    });
    // Cross-link everything on the POS transaction for audit.
    await this.db
      .update(posTransactions)
      .set({
        orderId: core.replacementOrder.id,
        metadata: {
          exchange: {
            originalOrderId: input.originalOrderId,
            refundId: core.refund.id,
            replacementOrderId: core.replacementOrder.id,
            returnTotal,
            replacementTotal,
            netDelta,
          },
        },
        updatedAt: new Date(),
      })
      .where(eq(posTransactions.id, txn.id));

    // An even exchange settles itself — nothing to tender.
    let finalTxn = txn;
    if (netDelta === 0) {
      const completed = await this.transactionService.complete(txn.id, core.replacementOrder.id);
      if (completed.ok) finalTxn = completed.value;
    } else {
      const rows = await this.db
        .select()
        .from(posTransactions)
        .where(eq(posTransactions.id, txn.id));
      if (rows[0]) finalTxn = rows[0] as Transaction;
    }

    return Ok({
      transaction: finalTxn,
      refundId: core.refund.id,
      returnTotal,
      replacementOrderId: core.replacementOrder.id,
      replacementTotal,
      netDelta,
    });
  }
}
