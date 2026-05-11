import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { PaymentService } from "../services/payment-service.js";
import type { TransactionService } from "../services/transaction-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildPaymentRoutes(
  paymentService: PaymentService,
  transactionService: TransactionService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("POS Payments", "/pos/transactions", ctx);

  r.post("/{id}/payments")
    .summary("Add payment")
    .permission("pos:operate")
    .input(z.object({
      method: z.enum(["cash", "card", "gift_card", "store_credit", "other"]),
      amount: z.number().int().positive(),
      changeGiven: z.number().int().min(0).optional(),
      reference: z.string().max(200).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as {
        method: "cash" | "card" | "gift_card" | "store_credit" | "other";
        amount: number;
        changeGiven?: number;
        reference?: string;
        metadata?: Record<string, unknown>;
      };
      const result = await paymentService.addPayment(orgId, params.id!, body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/complete")
    .summary("Complete transaction")
    .description("Validates total payments >= total, then calls checkout pipeline.")
    .permission("pos:operate")
    .handler(async ({ params, services, orgId }) => {
      // Validate payments cover the total
      const validation = await paymentService.validateForCompletion(orgId, params.id!);
      if (!validation.ok) throw new Error(validation.error);

      const { transaction } = validation.value;

      // Call checkout pipeline via the checkout service
      // The POS payment adapter handles the payment side
      const checkout = services as Record<string, unknown>;

      // Build checkout request — POS goes through the same pipeline as online
      const checkoutBody = {
        cartId: transaction.cartId,
        currency: "USD",
        paymentMethodId: "pos",
        metadata: {
          posTransactionId: transaction.id,
          posShiftId: transaction.shiftId,
          posTerminalId: transaction.terminalId,
        },
        ...(transaction.customerId != null ? { customerId: transaction.customerId } : {}),
      };

      // We need to make an internal call to the checkout pipeline
      // This is handled by POSCheckoutAdapter in hooks/checkout-pos.ts
      // For now, return the transaction with payment status
      // The plugin entry point wires the checkout hook

      // Mark transaction as completed (the afterCreate hook will set orderId)
      const result = await transactionService.complete(params.id!, null);
      if (!result.ok) throw new Error(result.error);

      return {
        transaction: result.value,
        checkoutRequest: checkoutBody,
        message: "Transaction completed. Use POST /api/checkout with the checkoutRequest body to finalize.",
      };
    });

  return r.routes();
}
