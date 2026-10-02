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
  }>, tx?: Db): Promise<PluginResult<ReturnItem[]>> {
    if (items.length === 0) return Err("At least one item is required");

    const db = tx ?? this.db;
    const values = items.map((item) => ({
      transactionId,
      originalOrderId: item.originalOrderId,
      originalLineItemId: item.originalLineItemId,
      quantity: item.quantity,
      reason: item.reason,
      restockingFee: item.restockingFee ?? 0,
      refundAmount: item.refundAmount,
    }));

    const rows = await db
      .insert(posReturnItems)
      .values(values)
      .returning();

    return Ok(rows);
  }

}
