import { eq, and, lt } from "drizzle-orm";
import type { Actor } from "../../auth/types.js";
import { orders } from "./schema.js";
import type { TaskDefinition } from "../../kernel/jobs/types.js";

function systemActorForOrg(organizationId: string): Actor {
  return {
    type: "user",
    userId: "system",
    email: null,
    name: "System",
    vendorId: null,
    organizationId,
    role: "admin",
    permissions: ["*:*"],
  };
}

/**
 * Stale Order Cleanup Task
 *
 * Cancels orders stuck in "pending" status for longer than the configured
 * threshold (default: 48 hours). This releases reserved inventory and
 * refunds captured payments, preventing phantom stock loss from abandoned
 * orders.
 *
 * Register via config.jobs.tasks:
 * ```ts
 * import { staleOrderCleanupTask } from "@porulle/core";
 * defineConfig({
 *   jobs: {
 *     tasks: [staleOrderCleanupTask],
 *     autorun: { enabled: true, intervalMs: 3600_000 }, // hourly
 *   },
 * });
 * ```
 */
export const staleOrderCleanupTask: TaskDefinition<
  { thresholdHours?: number },
  { cancelledCount: number; orderIds: string[] }
> = {
  slug: "orders/stale-cleanup",

  async handler({ input, ctx }) {
    const thresholdHours = input.thresholdHours ?? 48;
    const cutoff = new Date(Date.now() - thresholdHours * 60 * 60 * 1000);

    // Find stale pending orders
    const staleOrders = await ctx.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.status, "pending"),
          lt(orders.placedAt, cutoff),
        ),
      );

    const cancelledIds: string[] = [];

    // Cancel each stale order via the service (triggers inventory release + payment refund)
    const orderService = ctx.services.orders as {
      cancel(orderId: string, actor: Actor | null, reason: string): Promise<unknown>;
    };

    for (const order of staleOrders) {
      try {
        await orderService.cancel(
          order.id,
          systemActorForOrg(order.organizationId),
          `Auto-cancelled: pending for >${thresholdHours}h`,
        );
        cancelledIds.push(order.id);
        ctx.logger.info(`Stale order ${order.orderNumber} auto-cancelled`, {
          orderId: order.id,
          placedAt: order.placedAt,
        });
      } catch (error) {
        ctx.logger.error(`Failed to cancel stale order ${order.orderNumber}`, { error });
      }
    }

    return {
      output: {
        cancelledCount: cancelledIds.length,
        orderIds: cancelledIds,
      },
    };
  },
};
