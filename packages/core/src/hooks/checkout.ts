import { CommerceValidationError } from "../kernel/errors.js";
import { resolveOrgId } from "../auth/org.js";
import type { CompensationFailuresRepository } from "../kernel/compensation/repository.js";
import type { AfterHook, BeforeHook } from "../kernel/hooks/types.js";
import type { ShippingAddress } from "../modules/shipping/calculator.js";
import type { AppliedPromotion } from "../modules/promotions/service.js";
import { runCompensationChain } from "../kernel/compensation/executor.js";
import type { CompensationContext } from "../kernel/compensation/types.js";
import type { TxContext } from "../kernel/database/tx-context.js";
import {
  reserveInventoryStep,
  capturePaymentStep,
  initiateFulfillmentStep,
  sendConfirmationStep,
} from "./checkout-completion.js";

export interface OrderResult {
  id: string;
  status?: string | undefined;
  customerId?: string | null | undefined;
  currency: string;
  subtotal?: number | undefined;
  discountTotal?: number | undefined;
  taxTotal?: number | undefined;
  shippingTotal?: number | undefined;
  grandTotal?: number | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  lineItems?: Array<{
    entityId: string;
    entityType?: string | undefined;
    title?: string | undefined;
    variantId?: string | null | undefined;
    quantity: number;
    unitPrice?: number | undefined;
    totalPrice?: number | undefined;
  }> | undefined;
}

export interface CheckoutLineItem {
  id?: string;
  entityId: string;
  entityType?: string;
  title?: string;
  variantId?: string;
  quantity: number;
  resolvedUnitPrice?: number;
  resolvedTotal?: number;
  discountAmount?: number;
  taxAmount?: number;
  priceBreakdown?: Array<{
    label: string;
    amountBefore: number;
    delta: number;
    amountAfter: number;
  }>;
}

export interface CheckoutData {
  checkoutId: string;
  cartId: string;
  customerId?: string;
  customerGroupIds?: string[];
  currency: string;
  paymentMethodId: string;
  lineItems: CheckoutLineItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  total: number;
  promotionCodes?: string[];
  paymentIntentId?: string;
  paymentClientSecret?: string | undefined;
  shippingAddress?: ShippingAddress;
  appliedPromotions?: AppliedPromotion[];
  freeShipping?: boolean;
  taxTransactionId?: string;
  metadata?: Record<string, unknown>;
}

function recalculateTotals(data: CheckoutData): void {
  data.total = Math.max(
    0,
    data.subtotal - data.discountTotal + data.taxTotal + data.shippingTotal,
  );
}

export const validateCartNotEmpty: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  const cartService = context.services.cart as {
    getById(id: string, actor?: unknown): Promise<
      | {
          ok: true;
          value: {
            organizationId?: string;
            status?: string;
            expiresAt?: Date | string;
            lineItems: Array<{
              id: string;
              entityId: string;
              variantId?: string | null;
              quantity: number;
            }>;
          };
        }
      | { ok: false }
    >;
    claimForCheckout(cartId: string, ctx?: unknown): Promise<
      | { ok: true; value: { id: string } }
      | { ok: false; error: { message: string } }
    >;
  };
  const catalogService = context.services.catalog as {
    getById(
      id: string,
      options?: { includeAttributes?: boolean },
    ): Promise<
      | {
          ok: true;
          value: {
            type: string;
            attributes?: Array<{ title: string; locale: string }>;
          };
        }
      | { ok: false }
    >;
  };

  // M1 fix: Atomically claim the cart for checkout (active → checking_out).
  // If a concurrent request already claimed it, this returns Err and we fail fast.
  const claimed = await cartService.claimForCheckout(data.cartId, context.tx);
  if (!claimed.ok) {
    throw new CommerceValidationError(
      "Cart is not available for checkout. It may have already been checked out by a concurrent request.",
    );
  }

  const cart = await cartService.getById(data.cartId, context.actor);
  if (!cart.ok || cart.value.lineItems.length === 0) {
    throw new CommerceValidationError("Cannot checkout an empty cart.");
  }

  // Cross-org guard: prevent org B from checking out org A's cart
  const actorOrgId = resolveOrgId(context.actor);
  if (cart.value.organizationId && cart.value.organizationId !== actorOrgId) {
    throw new CommerceValidationError("Cart does not belong to this organization.");
  }

  // Default currency to cart's currency if not provided
  const cartCurrency = (cart.value as Record<string, unknown>).currency as string | undefined;
  if (!data.currency && cartCurrency) {
    data.currency = cartCurrency;
  }

  // Reject expired carts
  if (cart.value.expiresAt) {
    const expiry = cart.value.expiresAt instanceof Date ? cart.value.expiresAt : new Date(cart.value.expiresAt);
    if (expiry.getTime() < Date.now()) {
      throw new CommerceValidationError("Cart has expired. Please create a new cart.");
    }
  }

  // Enrich line items with entity title and type from catalog (in parallel)
  data.lineItems = await Promise.all(
    cart.value.lineItems.map(async (item) => {
      const entity = await catalogService.getById(item.entityId, {
        includeAttributes: true,
      });
      const title = entity.ok
        ? (entity.value.attributes?.[0]?.title ?? item.entityId)
        : item.entityId;
      const entityType = entity.ok ? entity.value.type : "product";
      return {
        id: item.id,
        entityId: item.entityId,
        entityType,
        title,
        quantity: item.quantity,
        // Use != null to exclude both null (DB value) and undefined
        ...(item.variantId != null ? { variantId: item.variantId } : {}),
      };
    }),
  );

  return data;
};

export const resolveCurrentPrices: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  const pricing = context.services.pricing as {
    resolve(params: {
      entityId: string;
      variantId?: string;
      currency: string;
      quantity: number;
      customerId?: string;
      customerGroupIds?: string[];
    }, actor?: unknown): Promise<
      | {
          ok: true;
          value: {
            finalAmount: number;
            breakdown: Array<{
              label: string;
              amountBefore: number;
              delta: number;
              amountAfter: number;
            }>;
          };
        }
      | { ok: false }
    >;
  };

  for (const item of data.lineItems) {
    const price = await pricing.resolve({
      entityId: item.entityId,
      currency: data.currency,
      quantity: item.quantity,
      ...(item.variantId !== undefined ? { variantId: item.variantId } : {}),
      ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
      ...(data.customerGroupIds !== undefined
        ? { customerGroupIds: data.customerGroupIds }
        : {}),
    }, context.actor);

    if (!price.ok) {
      throw new CommerceValidationError(
        `Cannot resolve price for ${item.entityId}.`,
      );
    }

    item.resolvedUnitPrice = price.value.finalAmount;
    item.resolvedTotal = price.value.finalAmount * item.quantity;
    item.priceBreakdown = price.value.breakdown;
    item.discountAmount = 0;
    item.taxAmount = 0;
  }

  data.subtotal = data.lineItems.reduce(
    (sum, item) => sum + (item.resolvedTotal ?? 0),
    0,
  );
  recalculateTotals(data);
  return data;
};

export const checkInventoryAvailability: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  const inventory = context.services.inventory as {
    getAvailable(
      entityId: string,
      variantId?: string,
      ctx?: unknown,
      actor?: unknown,
    ): Promise<{ ok: boolean; value?: number }>;
  };

  for (const item of data.lineItems) {
    const available = await inventory.getAvailable(
      item.entityId,
      item.variantId,
      context.tx,
      context.actor,
    );
    if (!available.ok || (available.value ?? 0) < item.quantity) {
      throw new CommerceValidationError(
        `Insufficient stock for ${item.title ?? item.entityId}. Available: ${
          available.ok ? (available.value ?? 0) : 0
        }, requested: ${item.quantity}.`,
      );
    }
  }

  return data;
};

export const applyPromotionCodes: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  const promotions = context.services.promotions as {
    applyPromotions(input: {
      orgId?: string;
      cartId?: string;
      customerId?: string;
      customerGroupIds?: string[];
      currency: string;
      subtotal: number;
      lineItems: Array<{
        entityId: string;
        entityType: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
      }>;
      promotionCodes?: string[];
    }): Promise<
      | {
          ok: true;
          value: {
            totalDiscount: number;
            freeShipping: boolean;
            applied: AppliedPromotion[];
            rejectedCodes: Array<{ code: string; reason: string }>;
          };
        }
      | { ok: false; error: Error }
    >;
  };

  const result = await promotions.applyPromotions({
    orgId: resolveOrgId(context.actor),
    cartId: data.cartId,
    currency: data.currency,
    subtotal: data.subtotal,
    lineItems: data.lineItems.map((lineItem) => ({
      entityId: lineItem.entityId,
      entityType: lineItem.entityType ?? "product",
      quantity: lineItem.quantity,
      unitPrice: lineItem.resolvedUnitPrice ?? 0,
      totalPrice: lineItem.resolvedTotal ?? 0,
    })),
    ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
    ...(data.customerGroupIds !== undefined
      ? { customerGroupIds: data.customerGroupIds }
      : {}),
    ...(data.promotionCodes !== undefined
      ? { promotionCodes: data.promotionCodes }
      : {}),
  });

  if (!result.ok) {
    throw new CommerceValidationError(
      `Promotion application failed: ${result.error.message}`,
    );
  }

  data.discountTotal = result.value.totalDiscount;
  data.appliedPromotions = result.value.applied;
  data.freeShipping = result.value.freeShipping;

  recalculateTotals(data);
  return data;
};

export const calculateTax: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  const tax = context.services.tax as {
    calculate(input: {
      currency: string;
      customerId?: string;
      shippingAmount: number;
      fromAddress?: ShippingAddress;
      toAddress?: ShippingAddress;
      lineItems: Array<{
        id: string;
        entityId: string;
        description: string;
        quantity: number;
        unitPrice: number;
        discount?: number;
      }>;
    }): Promise<
      | { ok: true; value: { amountToCollect: number } }
      | { ok: false; error: Error }
    >;
  };

  const calculated = await tax.calculate({
    currency: data.currency,
    shippingAmount: data.shippingTotal,
    lineItems: data.lineItems.map((lineItem) => ({
      id: lineItem.id ?? `${lineItem.entityId}:${lineItem.variantId ?? "_"}`,
      entityId: lineItem.entityId,
      description: lineItem.title ?? lineItem.entityId,
      quantity: lineItem.quantity,
      unitPrice: lineItem.resolvedUnitPrice ?? 0,
      ...(lineItem.discountAmount !== undefined
        ? { discount: lineItem.discountAmount }
        : {}),
    })),
    ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
    ...(data.shippingAddress !== undefined
      ? { toAddress: data.shippingAddress }
      : {}),
  });

  if (!calculated.ok) {
    throw new CommerceValidationError(
      `Tax calculation failed: ${calculated.error.message}`,
    );
  }

  data.taxTotal = Math.max(0, Math.round(calculated.value.amountToCollect));
  recalculateTotals(data);
  return data;
};

export const calculateShipping: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  const shippingService = context.services.shipping as {
    calculate(input: {
      lineItems: Array<{
        entityId: string;
        variantId?: string;
        quantity: number;
        resolvedTotal: number;
      }>;
      subtotalAfterDiscount: number;
      currency: string;
      address?: ShippingAddress;
      isFreeShipping?: boolean;
    }): Promise<
      | {
          ok: true;
          value: { amount: number; strategy: string; weightGrams: number };
        }
      | { ok: false; error: Error }
    >;
  };

  const shipping = await shippingService.calculate({
    lineItems: data.lineItems.map((lineItem) => ({
      entityId: lineItem.entityId,
      quantity: lineItem.quantity,
      resolvedTotal: lineItem.resolvedTotal ?? 0,
      ...(lineItem.variantId !== undefined
        ? { variantId: lineItem.variantId }
        : {}),
    })),
    subtotalAfterDiscount: Math.max(0, data.subtotal - data.discountTotal),
    currency: data.currency,
    ...(data.shippingAddress !== undefined
      ? { address: data.shippingAddress }
      : {}),
    ...(data.freeShipping !== undefined
      ? { isFreeShipping: data.freeShipping }
      : {}),
  });

  if (!shipping.ok) {
    throw new CommerceValidationError(
      `Shipping calculation failed: ${shipping.error.message}`,
    );
  }

  data.shippingTotal = shipping.value.amount;
  recalculateTotals(data);
  return data;
};

export const validatePaymentMethod: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  if (!data.paymentMethodId) {
    throw new CommerceValidationError("Payment method is required.");
  }

  // H1 fix: Validate paymentMethodId against registered adapters
  const payments = context.services.payments as {
    registeredProviderIds?: string[];
  };
  if (
    payments.registeredProviderIds &&
    payments.registeredProviderIds.length > 0 &&
    !payments.registeredProviderIds.includes(data.paymentMethodId)
  ) {
    throw new CommerceValidationError(
      `Unknown payment method "${data.paymentMethodId}". ` +
      `Available methods: [${payments.registeredProviderIds.join(", ")}].`,
    );
  }

  return data;
};

export const authorizePayment: BeforeHook<CheckoutData> = async ({
  data,
  context,
}) => {
  const payments = context.services.payments as {
    authorize(input: {
      amount: number;
      currency: string;
      paymentMethodId: string;
      customerId?: string;
      metadata: Record<string, unknown>;
    }): Promise<{
      ok: boolean;
      value?: { id: string; clientSecret?: string | null };
      error?: { message: string };
    }>;
  };
  const authorized = await payments.authorize({
    amount: data.total,
    currency: data.currency,
    paymentMethodId: data.paymentMethodId,
    metadata: {
      checkoutId: data.checkoutId,
      cartId: data.cartId,
    },
    ...(data.customerId !== undefined ? { customerId: data.customerId } : {}),
  });

  if (!authorized.ok || !authorized.value) {
    throw new CommerceValidationError(
      `Payment authorization failed: ${authorized.error?.message ?? "Unknown payment error."}`,
    );
  }

  data.paymentIntentId = authorized.value.id;
  data.paymentClientSecret = authorized.value.clientSecret ?? undefined;
  context.context.paymentIntentId = authorized.value.id;
  return data;
};

export const capturePayment: AfterHook<OrderResult> = async ({ context }) => {
  const payments = context.services.payments as {
    capture(paymentIntentId: string, amount?: number, paymentMethodId?: string): Promise<unknown>;
  };
  const paymentIntentId = context.context.paymentIntentId as string | undefined;
  const paymentMethodId = context.context.paymentMethodId as string | undefined;
  if (!paymentIntentId) return;
  await payments.capture(paymentIntentId, undefined, paymentMethodId);
};

export const reserveInventory: AfterHook<OrderResult> = async ({ result, context }) => {
  const inventory = context.services.inventory as {
    reserve(input: {
      entityId: string;
      variantId?: string;
      quantity: number;
      orderId: string;
      performedBy: string;
    }): Promise<unknown>;
  };
  for (const lineItem of result.lineItems ?? []) {
    await inventory.reserve({
      entityId: lineItem.entityId,
      ...(lineItem.variantId != null ? { variantId: lineItem.variantId } : {}),
      quantity: lineItem.quantity,
      orderId: result.id,
      performedBy: context.actor?.userId ?? "system",
    });
  }
};

export const initiateFulfillment: AfterHook<OrderResult> = async ({
  result,
  context,
}) => {
  const fulfillment = context.services.fulfillment as {
    fulfillOrder(orderId: string, actor?: unknown): Promise<unknown>;
  };
  await fulfillment.fulfillOrder(result.id, context.actor);
};

export const sendConfirmation: AfterHook<OrderResult> = async ({ result, context }) => {
  const customers = context.services.customers as {
    getByUserId(
      userId: string,
      actor?: unknown,
    ): Promise<{ ok: boolean; value?: { email?: string } }>;
  };
  const email = context.services.email as
    | {
        send(input: {
          template: string;
          to: string;
          data?: Record<string, unknown>;
        }): Promise<void>;
      }
    | undefined;

  if (!result.customerId || !email?.send) return;
  const customer = await customers.getByUserId(result.customerId, context.actor);
  if (!customer.ok || !customer.value?.email) return;

  await email.send({
    template: "order-confirmation",
    to: customer.value.email,
    data: { order: result },
  });
};

/**
 * Analytics event recording — intentional no-op.
 *
 * The DrizzleAnalyticsAdapter queries source tables (orders, inventory)
 * directly via SQL, so no separate event recording is needed. The export
 * is preserved for backwards compatibility with checkout route imports.
 */
export const recordAnalyticsEvent: AfterHook<OrderResult> = async () => {
  // No-op: source tables ARE the analytics events.
};

/**
 * Replaces the separate capturePayment and reserveInventory AfterHooks
 * with a single compensation chain that can roll back completed steps
 * if any step fails.
 *
 * Order of steps:
 *   1. Reserve inventory — if this fails, no money is charged
 *   2. Capture payment — if this fails, inventory reservations are released
 *   3. Initiate fulfillment — best-effort, does not fail the chain
 *   4. Send confirmation — best-effort, does not fail the chain
 *
 * Both failure modes leave the system in a consistent state.
 */
export const completeCheckout: AfterHook<OrderResult> = async ({
  result: order,
  context,
}) => {
  const paymentIntentId = context.context.paymentIntentId as
    | string
    | undefined;

  const checkoutData: CheckoutData = {
    checkoutId: order.id,
    cartId: (order.metadata?.cartId as string) ?? "",
    ...(order.customerId != null ? { customerId: order.customerId } : {}),
    currency: order.currency,
    paymentMethodId: (context.context.paymentMethodId as string) ?? "",
    lineItems: (order.lineItems ?? []).map((li) => ({
      id: li.entityId,
      entityId: li.entityId,
      ...(li.entityType != null ? { entityType: li.entityType } : {}),
      title: li.title ?? li.entityId,
      ...(li.variantId != null ? { variantId: li.variantId } : {}),
      quantity: li.quantity,
      ...(li.unitPrice != null ? { resolvedUnitPrice: li.unitPrice } : {}),
      ...(li.totalPrice != null ? { resolvedTotal: li.totalPrice } : {}),
    })),
    subtotal: order.subtotal ?? 0,
    discountTotal: order.discountTotal ?? 0,
    taxTotal: order.taxTotal ?? 0,
    shippingTotal: order.shippingTotal ?? 0,
    total: order.grandTotal ?? 0,
    ...(paymentIntentId != null ? { paymentIntentId } : {}),
  };

  const compensationCtx: CompensationContext = {
    tx: (context.tx as TxContext | null) ?? null,
    hook: context,
    ...(context.services.compensationFailures != null
      ? {
          failureRepository: context.services
            .compensationFailures as CompensationFailuresRepository,
        }
      : {}),
    correlationId: order.id,
    chainName: "checkout",
  };

  const chainResult = await runCompensationChain(
    [
      reserveInventoryStep,
      capturePaymentStep,
      initiateFulfillmentStep,
      sendConfirmationStep,
    ],
    checkoutData,
    compensationCtx,
  );

  if (!chainResult.ok) {
    // Mark order as failed if compensation chain did not succeed
    const orders = context.services.orders as {
      changeStatus?(input: { orderId: string; newStatus: string }, actor: unknown): Promise<unknown>;
    };
    if (orders.changeStatus) {
      try {
        await orders.changeStatus({ orderId: order.id, newStatus: "cancelled" }, context.actor);
      } catch (statusError) {
        context.logger.error(
          `Failed to update order ${order.id} status to cancelled after checkout failure.`,
          { statusError },
        );
      }
    }
    throw chainResult.error;
  }
};
