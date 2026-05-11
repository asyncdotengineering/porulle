/**
 * Order lifecycle email notifications.
 *
 * Sends emails on status changes: confirmed, fulfilled, cancelled, refunded.
 * Registered as an orders.afterStatusChange hook.
 */

import type { AfterHook } from "../kernel/hooks/types.js";

interface StatusChangeResult {
  orderId: string;
  customerId?: string | null;
  newStatus: string;
  previousStatus: string;
}

export const sendOrderStatusEmail: AfterHook<StatusChangeResult> = async ({
  result,
  context,
}) => {
  const email = context.services.email as
    | { send(input: { template: string; to: string; data?: Record<string, unknown> }): Promise<void> }
    | undefined;

  if (!email?.send) return;

  // Only send for customer-facing status changes
  const notifiableStatuses = ["confirmed", "processing", "fulfilled", "cancelled", "refunded"];
  if (!notifiableStatuses.includes(result.newStatus)) return;

  // Look up customer email
  const customerId = result.customerId;
  if (!customerId) return;

  const customers = context.services.customers as
    | { getByUserId(id: string, actor?: unknown): Promise<{ ok: boolean; value?: { email?: string | null } }> }
    | undefined;

  if (!customers) return;

  try {
    const customer = await customers.getByUserId(customerId, context.actor);
    if (!customer.ok || !customer.value?.email) return;

    await email.send({
      template: "order-status-change",
      to: customer.value.email,
      data: {
        orderId: result.orderId,
        newStatus: result.newStatus,
        previousStatus: result.previousStatus,
      },
    });
  } catch (err) {
    // Email failure must not break the order flow
    context.logger.warn("Order status email failed", {
      orderId: result.orderId,
      newStatus: result.newStatus,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
