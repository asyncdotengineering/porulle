import { createHookContext } from "../../kernel/hooks/create-context.js";
import { runBeforeHooks } from "../../kernel/hooks/executor.js";
import {
  resolveCurrentPrices,
  applyPromotionCodes,
  calculateShipping,
  calculateTax,
  type CheckoutData,
} from "../../hooks/checkout.js";
import type { Kernel } from "../../runtime/kernel.js";
import type { Actor } from "../../auth/types.js";
import type { ServiceContainer } from "../../kernel/hooks/types.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import type { ShippingAddress } from "../shipping/calculator.js";
import { makeId } from "../../utils/id.js";

export interface OrderPricingInput {
  currency: string;
  lineItems: Array<{
    entityId: string;
    entityType?: string;
    variantId?: string;
    quantity: number;
    title?: string;
  }>;
  customerId?: string;
  customerGroupIds?: string[];
  promotionCodes?: string[];
  shippingAddress?: ShippingAddress;
}

export interface OrderPricingBreakdown {
  currency: string;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;
  lineItems: Array<{
    entityId: string;
    variantId?: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    discountAmount: number;
    taxAmount: number;
  }>;
}

/**
 * The single pricing authority for an order. Runs the SAME hooks checkout runs —
 * `resolveCurrentPrices → applyPromotionCodes → calculateShipping → calculateTax`
 * (shipping before tax so `appliesToShipping` rates fire) — against a synthetic
 * `CheckoutData`, with NO cart claim, inventory check, or payment side effects.
 *
 * Because it reuses the checkout hooks verbatim, a manual-order quote produced
 * here equals what checkout will actually charge for the same inputs — there is
 * no second pricing implementation to drift. Used by `POST /api/orders/quote`
 * and available to any manual/draft-order flow.
 */
export async function computeOrderPricing(
  kernel: Kernel,
  input: OrderPricingInput,
  actor: Actor | null,
  tx?: unknown,
): Promise<OrderPricingBreakdown> {
  const data: CheckoutData = {
    checkoutId: makeId(),
    cartId: "",
    currency: input.currency,
    paymentMethodId: "",
    lineItems: input.lineItems.map((li) => ({
      id: `${li.entityId}:${li.variantId ?? "_"}`,
      entityId: li.entityId,
      ...(li.entityType !== undefined ? { entityType: li.entityType } : {}),
      ...(li.variantId !== undefined ? { variantId: li.variantId } : {}),
      title: li.title ?? li.entityId,
      quantity: li.quantity,
    })),
    subtotal: 0,
    discountTotal: 0,
    taxTotal: 0,
    shippingTotal: 0,
    total: 0,
    ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
    ...(input.customerGroupIds !== undefined
      ? { customerGroupIds: input.customerGroupIds }
      : {}),
    ...(input.promotionCodes !== undefined
      ? { promotionCodes: input.promotionCodes }
      : {}),
    ...(input.shippingAddress !== undefined
      ? { shippingAddress: input.shippingAddress }
      : {}),
  };

  const context = createHookContext({
    actor,
    logger: kernel.logger,
    services: kernel.services as ServiceContainer,
    context: { moduleName: "orders" },
    origin: "rest",
    database: { db: kernel.database.db as PluginDb },
  });
  if (tx !== undefined) context.tx = tx as typeof context.tx;

  const priced = await runBeforeHooks(
    [resolveCurrentPrices, applyPromotionCodes, calculateShipping, calculateTax],
    data,
    "create",
    context,
  );

  return {
    currency: priced.currency,
    subtotal: priced.subtotal,
    discountTotal: priced.discountTotal,
    shippingTotal: priced.shippingTotal,
    taxTotal: priced.taxTotal,
    grandTotal: priced.total,
    lineItems: priced.lineItems.map((li) => ({
      entityId: li.entityId,
      ...(li.variantId !== undefined ? { variantId: li.variantId } : {}),
      quantity: li.quantity,
      unitPrice: li.resolvedUnitPrice ?? 0,
      totalPrice: li.resolvedTotal ?? 0,
      discountAmount: li.discountAmount ?? 0,
      taxAmount: li.taxAmount ?? 0,
    })),
  };
}
