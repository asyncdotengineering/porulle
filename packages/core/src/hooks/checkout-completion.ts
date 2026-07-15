import type { Step } from "../kernel/compensation/types.js";
import type { CheckoutData } from "./checkout.js";
import { Ok, Err } from "../kernel/result.js";
import { CommerceValidationError } from "../kernel/errors.js";

// Service type narrowing — these mirror the actual service interfaces
// without creating circular imports.

interface InventoryServiceLike {
  reserve(input: {
    entityId: string;
    variantId?: string;
    quantity: number;
    orderId: string;
    performedBy: string;
  }, actor?: unknown): Promise<{ ok: boolean; error?: { message: string } }>;
  release(input: {
    entityId: string;
    variantId?: string;
    quantity: number;
    orderId: string;
    performedBy: string;
  }, actor?: unknown): Promise<unknown>;
}

interface PaymentsServiceLike {
  capture(
    paymentIntentId: string,
    amount?: number,
  ): Promise<{
    ok: boolean;
    value?: { amountCaptured: number };
    error?: { message: string };
  }>;
  refund(
    paymentId: string,
    amount: number,
    reason?: string,
  ): Promise<unknown>;
}

interface OrdersServiceLike {
  updateStatus?(
    orderId: string,
    status: string,
    reason?: string,
  ): Promise<unknown>;
}

/**
 * Reservation record produced by the reserve-inventory step.
 * Passed to compensate() so it knows exactly what to undo.
 */
export interface InventoryReservation {
  entityId: string;
  variantId: string | undefined;
  quantity: number;
  orderId: string;
}

/**
 * Step 1: Reserve inventory.
 *
 * Output: the list of reservations created.
 * Compensate: release each reservation.
 *
 * Inventory reservation runs BEFORE payment capture. This is deliberate:
 * if stock is unavailable, we should find out before charging the customer.
 * The compensation for this step releases the reserved quantities.
 */
export const reserveInventoryStep: Step<
  CheckoutData,
  InventoryReservation[]
> = {
  id: "reserve-inventory",

  async run(data, ctx) {
    const inventory = ctx.hook.services.inventory as InventoryServiceLike;
    const reservations: InventoryReservation[] = [];
    const performedBy = ctx.hook.actor?.userId ?? "system";

    for (const item of data.lineItems) {
      const result = await inventory.reserve(
        {
          entityId: item.entityId,
          ...(item.variantId != null ? { variantId: item.variantId } : {}),
          quantity: item.quantity,
          orderId: data.checkoutId,
          performedBy,
        },
        ctx.hook.actor,
      );

      if (!result.ok) {
        return Err(
          new CommerceValidationError(
            `Inventory reservation failed for ${item.title ?? item.entityId}: ${result.error?.message ?? "unknown"}`,
          ),
        );
      }

      reservations.push({
        entityId: item.entityId,
        variantId: item.variantId,
        quantity: item.quantity,
        orderId: data.checkoutId,
      });
    }

    return Ok(reservations);
  },

  async compensate(reservations, ctx) {
    const inventory = ctx.hook.services.inventory as InventoryServiceLike;
    const performedBy = ctx.hook.actor?.userId ?? "system";

    for (const r of reservations) {
      await inventory.release(
        {
          entityId: r.entityId,
          ...(r.variantId != null ? { variantId: r.variantId } : {}),
          quantity: r.quantity,
          orderId: r.orderId,
          performedBy,
        },
        ctx.hook.actor,
      );
    }
  },
};

/**
 * Step 2: Capture payment.
 *
 * Output: the captured payment intent ID and amount.
 * Compensate: issue a full refund via the payments service.
 *
 * Runs AFTER inventory reservation. If capture fails, inventory reservations
 * are released by the compensation chain. If capture succeeds but a later step
 * fails, a refund is issued.
 */
export const capturePaymentStep: Step<
  CheckoutData,
  { paymentIntentId: string; amount: number }
> = {
  id: "capture-payment",

  async run(data, ctx) {
    if (!data.paymentIntentId) {
      return Err(
        new CommerceValidationError(
          "No authorized payment intent to capture.",
        ),
      );
    }

    const payments = ctx.hook.services.payments as PaymentsServiceLike;
    const result = await payments.capture(data.paymentIntentId);

    if (!result.ok) {
      return Err(
        new CommerceValidationError(
          `Payment capture failed: ${result.error?.message ?? "unknown"}`,
        ),
      );
    }
    if (typeof result.value?.amountCaptured === "number") {
      const orders = ctx.hook.services.orders as {
        updateOrder?(
          orderId: string,
          data: { amountCaptured?: number },
          actor?: unknown,
        ): Promise<{ ok: boolean }>;
      };
      if (orders.updateOrder) {
        const updated = await orders.updateOrder(
          data.checkoutId,
          { amountCaptured: result.value.amountCaptured },
          ctx.hook.actor,
        );
        if (!updated.ok) {
          return Err(new CommerceValidationError("Failed to persist captured payment amount."));
        }
      }
    }

    return Ok({ paymentIntentId: data.paymentIntentId, amount: data.total });
  },

  async compensate({ paymentIntentId, amount }, ctx) {
    const payments = ctx.hook.services.payments as PaymentsServiceLike;
    await payments.refund(
      paymentIntentId,
      amount,
      "Checkout compensation: downstream step failed after payment capture",
    );
  },
};

/**
 * Step 3: Initiate fulfillment.
 *
 * Output: the order ID (for logging).
 * No compensate: fulfillment initiation is best-effort and idempotent.
 * A failed fulfillment should be retried through the job queue, not
 * compensated by rolling back the entire checkout.
 */
export const initiateFulfillmentStep: Step<
  CheckoutData,
  { orderId: string }
> = {
  id: "initiate-fulfillment",

  async run(data, ctx) {
    const fulfillment = ctx.hook.services.fulfillment as {
      fulfillOrder(orderId: string, actor?: unknown): Promise<unknown>;
    };

    try {
      await fulfillment.fulfillOrder(data.checkoutId, ctx.hook.actor);
    } catch (error) {
      // Fulfillment initiation failure should not fail the checkout.
      // The order is paid and inventory is reserved — fulfillment can be retried.
      ctx.hook.logger.warn(
        `Fulfillment initiation failed for order ${data.checkoutId}. Will need manual retry.`,
        { error },
      );
    }

    return Ok({ orderId: data.checkoutId });
  },

  // No compensate — fulfillment is best-effort at this stage
};

/**
 * Step 4: Send confirmation email.
 *
 * Output: void (best-effort).
 * No compensate: you cannot unsend an email.
 */
export const sendConfirmationStep: Step<
  CheckoutData,
  { sent: boolean }
> = {
  id: "send-confirmation",

  async run(data, ctx) {
    const customers = ctx.hook.services.customers as {
      getByUserId(
        userId: string,
        actor?: unknown,
      ): Promise<{ ok: boolean; value?: { email?: string } }>;
    };
    const email = ctx.hook.services.email as
      | {
          send(input: {
            template: string;
            to: string;
            data?: Record<string, unknown>;
          }): Promise<void>;
        }
      | undefined;

    if (!data.customerId || !email?.send) {
      return Ok({ sent: false });
    }

    try {
      const customer = await customers.getByUserId(data.customerId, ctx.hook.actor);
      if (customer.ok && customer.value?.email) {
        await email.send({
          template: "order-confirmation",
          to: customer.value.email,
          data: { orderId: data.checkoutId, total: data.total, currency: data.currency },
        });
        return Ok({ sent: true });
      }
    } catch (error) {
      // Email failure should not fail checkout
      ctx.hook.logger.warn(
        `Confirmation email failed for order ${data.checkoutId}.`,
        { error },
      );
    }

    return Ok({ sent: false });
  },

  // No compensate — cannot unsend an email
};
