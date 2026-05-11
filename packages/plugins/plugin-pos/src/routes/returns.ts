import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ReturnService } from "../services/return-service.js";
import type { TransactionService } from "../services/transaction-service.js";
import type { PaymentService } from "../services/payment-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildReturnRoutes(
  returnService: ReturnService,
  transactionService: TransactionService,
  paymentService: PaymentService,
  cartService: { create: (input: { currency?: string; metadata?: Record<string, unknown> }, actor: unknown) => Promise<{ ok: boolean; value?: { id: string } }> },
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Returns", "/pos/returns", ctx);

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
        refundAmount: z.number().int().positive(),
      })).min(1),
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
          refundAmount: number;
        }>;
      };

      // Create a cart for the return transaction
      const cartResult = await cartService.create(
        { currency: "USD", metadata: { posReturn: true } },
        actor,
      );
      if (!cartResult.ok || !cartResult.value) {
        throw new Error("Failed to create cart for return");
      }

      // Create return transaction
      const txnResult = await transactionService.create(orgId, {
        shiftId: body.shiftId,
        terminalId: body.terminalId,
        operatorId: actor!.userId,
        cartId: cartResult.value.id,
        type: "return",
      });
      if (!txnResult.ok) throw new Error(txnResult.error);

      // Record return items
      const itemsResult = await returnService.addReturnItems(
        txnResult.value.id,
        body.items.map((item) => ({
          ...item,
          originalOrderId: body.originalOrderId,
        })),
      );
      if (!itemsResult.ok) throw new Error(itemsResult.error);

      // Update transaction totals
      const refundTotal = body.items.reduce((sum, i) => sum + i.refundAmount, 0);
      await transactionService.updateTotals(txnResult.value.id, {
        subtotal: refundTotal,
        taxTotal: 0,
        total: refundTotal,
        discountTotal: 0,
      });

      return {
        transaction: txnResult.value,
        returnItems: itemsResult.value,
        refundTotal,
      };
    });

  r.post("/{id}/payments")
    .summary("Add refund payment")
    .permission("pos:operate")
    .input(z.object({
      method: z.enum(["cash", "card", "gift_card", "store_credit", "other"]),
      amount: z.number().int().positive(),
      reference: z.string().max(200).optional(),
    }))
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
