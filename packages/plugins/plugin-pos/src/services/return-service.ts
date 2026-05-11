import { eq } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posReturnItems } from "../schema.js";
import type { Db, ReturnItem } from "../types.js";

export class ReturnService {
  constructor(private db: Db) {}

  /**
   * Record return items linking back to an original order's line items.
   * Called after a return transaction is created.
   */
  async addReturnItems(transactionId: string, items: Array<{
    originalOrderId: string;
    originalLineItemId: string;
    quantity: number;
    reason: "defective" | "wrong_item" | "changed_mind" | "other";
    restockingFee?: number;
    refundAmount: number;
  }>): Promise<PluginResult<ReturnItem[]>> {
    if (items.length === 0) return Err("At least one item is required");

    const values = items.map((item) => ({
      transactionId,
      originalOrderId: item.originalOrderId,
      originalLineItemId: item.originalLineItemId,
      quantity: item.quantity,
      reason: item.reason,
      restockingFee: item.restockingFee ?? 0,
      refundAmount: item.refundAmount,
    }));

    const rows = await this.db
      .insert(posReturnItems)
      .values(values)
      .returning();

    return Ok(rows);
  }

  /**
   * Get all return items for a return transaction.
   */
  async getReturnItems(transactionId: string): Promise<PluginResult<ReturnItem[]>> {
    const rows = await this.db
      .select()
      .from(posReturnItems)
      .where(eq(posReturnItems.transactionId, transactionId));

    return Ok(rows);
  }

  /**
   * Calculate total refund amount for a return transaction.
   */
  async calculateRefundTotal(transactionId: string): Promise<number> {
    const items = await this.db
      .select()
      .from(posReturnItems)
      .where(eq(posReturnItems.transactionId, transactionId));

    return items.reduce((sum, item) => sum + item.refundAmount, 0);
  }
}
