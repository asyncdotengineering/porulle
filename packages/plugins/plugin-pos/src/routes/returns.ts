import { requireUserId, router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ReturnService } from "../services/return-service.js";
import type { TransactionService } from "../services/transaction-service.js";
import type { PaymentService } from "../services/payment-service.js";
import type { PluginRouteRegistration } from "@porulle/core";
import type { Db } from "../types.js";

const paymentInputSchema = z.object({
  method: z.enum(["cash", "card", "gift_card", "store_credit", "other"]),
  amount: z.number().int().positive(),
  reference: z.string().max(200).optional(),
});

export function buildReturnRoutes(
  returnService: ReturnService,
  transactionService: TransactionService,
  paymentService: PaymentService,
  cartService: { create: (input: { currency?: string; metadata?: Record<string, unknown> }, actor: unknown) => Promise<{ ok: boolean; value?: { id: string } }> },
  ctx: { services?: Record<string, unknown>; database?: { db: unknown; transaction?: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> } },
): PluginRouteRegistration[] {
  const r = router("POS Returns", "/pos/returns", ctx);
  const transactionFn = ctx.database?.transaction;
  if (!transactionFn) {
    throw new Error("POS returns require database.transaction from plugin context");
  }

  r.post("/")
    .summary("Create return")
    .permission("pos:manage")
    .input(z.object({
      shiftId: z.string().uuid(),
      terminalId: z.string().uuid(),
      originalOrderId: z.string().uuid(),
      items: z.array(z.object({
        originalLineItemId: z.string().uuid(),
        quantity: z.number().int().positive(),
        reason: z.enum(["defective", "wrong_item", "changed_mind", "other"]),
        restockingFee: z.number().int().min(0).optional(),
        // refundAmount is NOT accepted from the client — it is computed
        // server-side from the original order (SEC-08).
      })).min(1),
      payment: paymentInputSchema,
    }))
    .handler(async ({ input, actor, orgId }) => {
      const body = input as {
        shiftId: string;
        terminalId: string;
        originalOrderId: string;
        items: Array<{
          originalLineItemId: string;
          quantity: number;
          reason: "defective" | "wrong_item" | "changed_mind" | "other";
          restockingFee?: number;
        }>;
        payment: {
          method: "cash" | "card" | "gift_card" | "store_credit" | "other";
          amount: number;
          reference?: string;
        };
      };

      // Create a cart for the return transaction (outside the financial tx —
      // same pattern as exchanges).
      const cartResult = await cartService.create(
        { currency: "USD", metadata: { posReturn: true } },
        actor,
      );
      if (!cartResult.ok || !cartResult.value) {
        throw new Error("Failed to create cart for return");
      }

      const orders = ctx.services?.orders as
        | {
            refundLines(
              orderId: string,
              refundInput: { lines: Array<{ lineItemId: string; quantity: number }>; reason?: string },
              actor: unknown,
              txCtx?: { tx: Db; actor: unknown },
            ): Promise<{
              ok: boolean;
              value?: { refund: { amount: number; lines: Array<{ lineItemId: string; quantity: number; amount: number }> } };
              error?: { message?: string };
            }>;
          }
        | undefined;
      if (!orders?.refundLines) {
        throw new Error("Orders service unavailable for return refund");
      }

      const result = await transactionFn(async (tx) => {
        const txCtx = { tx, actor };

        const txnResult = await transactionService.create(orgId, {
          shiftId: body.shiftId,
          terminalId: body.terminalId,
          operatorId: requireUserId(actor),
          cartId: cartResult.value!.id,
          type: "return",
        }, tx);
        if (!txnResult.ok) throw new Error(txnResult.error);

        const refundResult = await orders.refundLines(
          body.originalOrderId,
          {
            lines: body.items.map((i) => ({ lineItemId: i.originalLineItemId, quantity: i.quantity })),
            reason: "pos_return",
          },
          actor,
          txCtx,
        );
        if (!refundResult.ok || !refundResult.value) {
          throw new Error(
            refundResult.error?.message ??
              "Return could not be validated against the original order.",
          );
        }

        const serverAmountByLine = new Map(
          refundResult.value.refund.lines.map((l) => [l.lineItemId, l.amount]),
        );
        const refundTotal = refundResult.value.refund.amount;

        if (body.payment.amount > refundTotal) {
          throw new Error(
            `Payment amount ${body.payment.amount} exceeds refund total ${refundTotal}`,
          );
        }

        const itemsResult = await returnService.addReturnItems(
          txnResult.value.id,
          body.items.map((item) => ({
            ...item,
            originalOrderId: body.originalOrderId,
            refundAmount: serverAmountByLine.get(item.originalLineItemId) ?? 0,
          })),
          tx,
        );
        if (!itemsResult.ok) throw new Error(itemsResult.error);

        await transactionService.updateTotals(txnResult.value.id, {
          subtotal: refundTotal,
          taxTotal: 0,
          total: refundTotal,
          discountTotal: 0,
        }, tx);

        const paymentResult = await paymentService.addPayment(
          orgId,
          txnResult.value.id,
          body.payment,
          tx,
        );
        if (!paymentResult.ok) throw new Error(paymentResult.error);

        return {
          transaction: txnResult.value,
          returnItems: itemsResult.value,
          refundTotal,
          payment: paymentResult.value,
        };
      }).catch((error: unknown) => error as Error);

      if (result instanceof Error) throw result;
      return result;
    });

  r.post("/{id}/payments")
    .summary("Add refund payment")
    .permission("pos:operate")
    .input(paymentInputSchema)
    .handler(async ({ params, input, orgId }) => {
      const body = input as { method: "cash" | "card" | "gift_card" | "store_credit" | "other"; amount: number; reference?: string };
      const result = await paymentService.addPayment(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/complete")
    .summary("Complete return")
    .permission("pos:operate")
    .handler(async ({ params, actor }) => {
      const result = await transactionService.complete(params.id!, null);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
