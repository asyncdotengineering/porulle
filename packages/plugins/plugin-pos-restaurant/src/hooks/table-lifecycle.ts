/**
 * Table Lifecycle Hooks
 *
 * URY equivalent: table_status_delete() in ury_pos_invoice.py.
 * URY clears occupied=0 on POS Invoice delete/cancel/submit.
 *
 * We hook into checkout.afterCreate to update table status when a
 * POS transaction completes, and pos transaction void to clear tables.
 */

import { eq } from "@porulle/core/drizzle";
import { posTableAssignments, posTables } from "../schema.js";
import type { Db } from "../types.js";

export function buildTableClearOnCompleteHook(getDb: () => Db) {
  return {
    key: "checkout.afterCreate",
    handler: async (...args: unknown[]) => {
      const hook = args[0] as {
        result: { id: string; metadata?: Record<string, unknown> | null };
        context: { [key: string]: unknown };
      };

      const metadata = hook.result?.metadata;
      const posTransactionId = (metadata as Record<string, unknown>)?.posTransactionId as string | undefined;
      if (!posTransactionId) return;

      const db = getDb();

      // Find table assignments for this transaction
      const assignments = await db
        .select()
        .from(posTableAssignments)
        .where(eq(posTableAssignments.transactionId, posTransactionId));

      // Set tables to "cleaning" (staff will set to "available" after bussing)
      for (const assignment of assignments) {
        await db
          .update(posTables)
          .set({ status: "cleaning", updatedAt: new Date() })
          .where(eq(posTables.id, assignment.tableId));
      }

      // Remove assignments
      await db
        .delete(posTableAssignments)
        .where(eq(posTableAssignments.transactionId, posTransactionId));
    },
  };
}
