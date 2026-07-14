/**
 * POS-specific checkout hooks.
 *
 * checkout.beforePayment: Sets shippingTotal = 0 for POS transactions (no shipping).
 * checkout.afterCreate: Updates POS transaction with orderId, increments shift counters.
 */

import { eq, and, sql } from "@porulle/core/drizzle";
import { posTransactions, posShifts } from "../schema.js";
import type { Db } from "../types.js";

interface CheckoutData {
  metadata?: Record<string, unknown> | null;
  shippingTotal: number;
  shippingAddress?: unknown;
  [key: string]: unknown;
}

interface OrderResult {
  id: string;
  grandTotal?: number;
  [key: string]: unknown;
}

interface HookContext {
  tx?: unknown;
  [key: string]: unknown;
}

/**
 * Before payment hook: zero out shipping for POS transactions.
 */
export function buildPOSShippingHook() {
  return {
    key: "checkout.beforePayment",
    handler: async (...args: unknown[]) => {
      const hook = args[0] as { data: CheckoutData; context: HookContext };
      const posTransactionId = hook.data.metadata?.posTransactionId;
      if (!posTransactionId) return hook.data;

      // POS transactions have no shipping
      hook.data.shippingTotal = 0;
      hook.data.shippingAddress = undefined;
      return hook.data;
    },
  };
}

/**
 * After create hook: finalize POS transaction with order details.
 */
export function buildPOSFinalizationHook(getDb: () => Db) {
  return {
    key: "checkout.afterCreate",
    handler: async (...args: unknown[]) => {
      const hook = args[0] as { result: OrderResult; context: HookContext };
      const result = hook.result;
      if (!result) return;

      // Check if this checkout was initiated by a POS transaction
      // The metadata is on the order, not directly on the hook result
      const metadata = (result as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
      const posTransactionId = metadata?.posTransactionId as string | undefined;
      if (!posTransactionId) return;

      const db = getDb();

      // Update transaction with orderId and status
      await db
        .update(posTransactions)
        .set({
          orderId: result.id,
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(posTransactions.id, posTransactionId));

      // Increment shift sales counters
      const posShiftId = metadata?.posShiftId as string | undefined;
      if (posShiftId) {
        const txnRows = await db
          .select({ organizationId: posTransactions.organizationId })
          .from(posTransactions)
          .where(eq(posTransactions.id, posTransactionId));
        const orgId = txnRows[0]?.organizationId;
        if (!orgId) return;

        await db
          .update(posShifts)
          .set({
            salesCount: sql`${posShifts.salesCount} + 1`,
            salesTotal: sql`${posShifts.salesTotal} + ${result.grandTotal ?? 0}`,
            updatedAt: new Date(),
          })
          .where(and(eq(posShifts.id, posShiftId), eq(posShifts.organizationId, orgId)));
      }
    },
  };
}
