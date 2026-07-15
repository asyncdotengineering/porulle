import { eq } from "drizzle-orm";
import { orders } from "../modules/orders/schema.js";
import type { Kernel } from "../runtime/kernel.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";

/**
 * Mark an order as paid (captured) for tests.
 *
 * Refund and return flows require a paid order — a refund moves collected money,
 * and the order primitive rejects refunds on unpaid/pending orders. There is no
 * public "set captured amount" service (capture() needs a live payment intent),
 * so tests set the column here through a single typed helper rather than
 * scattering raw SQL / `as any` casts across test files.
 */
export async function markOrderPaidForTest(
  kernel: Kernel,
  orderId: string,
  amountCaptured: number,
  paymentIntentId?: string,
): Promise<void> {
  const db = kernel.database.db as DrizzleDatabase;
  await db
    .update(orders)
    .set({ amountCaptured, ...(paymentIntentId ? { paymentIntentId } : {}) })
    .where(eq(orders.id, orderId));
}
