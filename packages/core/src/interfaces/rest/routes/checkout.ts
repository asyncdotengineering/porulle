import { OpenAPIHono } from "@hono/zod-openapi";
import type { Kernel } from "../../../runtime/kernel.js";
import { checkoutRoute } from "../schemas/checkout.js";
import {
  applyPromotionCodes,
  authorizePayment,
  calculateShipping,
  calculateTax,
  checkInventoryAvailability,
  completeCheckout,
  recordAnalyticsEvent,
  resolveCurrentPrices,
  validateCartNotEmpty,
  validatePaymentMethod,
  type CheckoutData,
  type OrderResult,
} from "../../../hooks/checkout.js";
import { runAfterHooks, runBeforeHooks } from "../../../kernel/hooks/executor.js";
import { createHookContext } from "../../../kernel/hooks/create-context.js";
import type { AfterHook, BeforeHook, ServiceContainer } from "../../../kernel/hooks/types.js";
import type { PluginDb } from "../../../kernel/database/plugin-types.js";
import { type AppEnv, mapErrorToResponse, mapErrorToStatus } from "../utils.js";
import { isCommerceError } from "../../../kernel/errors.js";
import { makeId } from "../../../utils/id.js";
import type { ShippingAddress } from "../../../modules/shipping/calculator.js";

export function checkoutRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (201 | 400 | 422). The route definition documents the
  // contract; the defaultHook handles Zod validation; the handler returns dynamic status.
  router.openapi(checkoutRoute, async (c) => {
    const body = c.req.valid("json");

    const actor = c.get("actor");
    const checkoutData: CheckoutData = {
      checkoutId: makeId(),
      cartId: body.cartId,
      currency: body.currency ?? "USD",
      paymentMethodId: body.paymentMethodId,
      lineItems: [],
      subtotal: 0,
      discountTotal: 0,
      taxTotal: 0,
      shippingTotal: 0,
      total: 0,
      ...(body.customerId !== undefined ? { customerId: body.customerId } : {}),
      ...(body.customerGroupIds !== undefined
        ? { customerGroupIds: body.customerGroupIds }
        : {}),
      ...(body.promotionCodes !== undefined
        ? { promotionCodes: body.promotionCodes }
        : {}),
      ...(body.shippingAddress != null
        ? {
            shippingAddress: {
              line1: body.shippingAddress.line1,
              city: body.shippingAddress.city,
              postalCode: body.shippingAddress.postalCode,
              country: body.shippingAddress.country,
              ...(body.shippingAddress.line2 != null ? { line2: body.shippingAddress.line2 } : {}),
              ...(body.shippingAddress.state != null ? { state: body.shippingAddress.state } : {}),
            },
          }
        : {}),
    };

    // ── Phase 1: Validate & Calculate (inside DB transaction — fast SQL only) ──
    const validationHooks: BeforeHook<CheckoutData>[] = [
      validateCartNotEmpty,
      resolveCurrentPrices,
      checkInventoryAvailability,
      applyPromotionCodes,
      calculateTax,
      calculateShipping,
      ...(kernel.hooks.resolve("checkout.beforePayment") as BeforeHook<CheckoutData>[]),
      validatePaymentMethod,
    ];

    // ── Phase 2: Payment Authorization (outside transaction — external API call) ──
    const paymentHooks: BeforeHook<CheckoutData>[] = [
      authorizePayment,
      ...(kernel.hooks.resolve("checkout.beforeCreate") as BeforeHook<CheckoutData>[]),
    ];

    const afterHooks: AfterHook<OrderResult>[] = [
      completeCheckout,
      recordAnalyticsEvent,
      ...(kernel.hooks.resolve("checkout.afterCreate") as AfterHook<OrderResult>[]),
    ];

    const context = createHookContext({
      actor,
      logger: kernel.logger,
      services: kernel.services as ServiceContainer,
      context: { moduleName: "checkout" },
      origin: "rest",
      database: { db: kernel.database.db as PluginDb },
    });

    try {
      // Phase 1: DB transaction for validation — releases connection immediately after
      const validated = await kernel.database.transaction(async (_tx) => {
        context.tx = _tx;
        return runBeforeHooks(
          validationHooks,
          checkoutData,
          "create",
          context,
        );
      });

      // Phase 2: Payment authorization — NO DB connection held while calling Stripe/etc.
      // If Stripe takes 5s, the DB connection pool is not affected.
      context.tx = null;
      const processed = await runBeforeHooks(
        paymentHooks,
        validated,
        "create",
        context,
      );

      // Resolve customer profile UUID from customerId (may be a profile UUID or a Better Auth user_id)
      let customerUuid: string | undefined = undefined;
      if (processed.customerId) {
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRe.test(processed.customerId)) {
          // Looks like a profile UUID — try direct lookup (no auto-create)
          const byIdResult = await kernel.services.customers.getById(
            processed.customerId,
            actor,
          );
          if (byIdResult.ok) {
            customerUuid = byIdResult.value.id;
          }
        }
        if (!customerUuid) {
          // Fall back to user_id lookup (auto-creates customer profile if needed)
          const byUserIdResult = await kernel.services.customers.getByUserId(
            processed.customerId,
            actor,
          );
          if (byUserIdResult.ok) {
            customerUuid = byUserIdResult.value.id;
          }
        }
        // If both lookups fail, we still allow guest checkout (customerUuid remains undefined)
      }

      const orderPayload = {
        currency: processed.currency,
        subtotal: processed.subtotal,
        taxTotal: processed.taxTotal,
        shippingTotal: processed.shippingTotal,
        discountTotal: processed.discountTotal,
        grandTotal: processed.total,
        paymentIntentId: processed.paymentIntentId,
        paymentMethodId: processed.paymentMethodId,
        metadata: {
          // H2 fix: Merge hook-injected metadata (e.g., BNPL fee) before core fields
          ...(typeof processed.metadata === "object" && processed.metadata !== null
            ? processed.metadata
            : {}),
          cartId: processed.cartId,
          paymentIntentId: processed.paymentIntentId,
          checkoutId: processed.checkoutId,
          promotionCodes: processed.promotionCodes,
          appliedPromotions: processed.appliedPromotions,
          shippingAddress: processed.shippingAddress,
        },
        lineItems: processed.lineItems.map((lineItem) => {
          const payload = {
            entityId: lineItem.entityId,
            entityType: lineItem.entityType ?? "product",
            title: lineItem.title ?? lineItem.entityId,
            quantity: lineItem.quantity,
            unitPrice: lineItem.resolvedUnitPrice ?? 0,
            totalPrice: lineItem.resolvedTotal ?? 0,
          };
          return lineItem.variantId !== undefined
            ? { ...payload, variantId: lineItem.variantId }
            : payload;
        }),
        ...(customerUuid !== undefined
          ? { customerId: customerUuid }
          : {}),
      };

      const order = await kernel.services.orders.create(orderPayload, actor);

      if (!order.ok) {
        return c.json(
          mapErrorToResponse(order.error),
          mapErrorToStatus(order.error),
        );
      }

      if (order.ok && (processed.appliedPromotions?.length ?? 0) > 0) {
        await kernel.services.promotions.recordUsage({
          promotions: processed.appliedPromotions ?? [],
          orderId: order.value.id,
          ...(customerUuid !== undefined
            ? { customerId: customerUuid }
            : {}),
        });
      }

      if (order.ok) {
        await kernel.services.tax.reportTransaction({
          transactionId: order.value.id,
          transactionDate: new Date(),
          currency: processed.currency,
          amount:
            processed.subtotal -
            processed.discountTotal +
            processed.shippingTotal,
          shipping: processed.shippingTotal,
          salesTax: processed.taxTotal,
          lineItems: processed.lineItems.map((lineItem, index) => ({
            id: lineItem.id ?? `${order.value.id}-${index + 1}`,
            entityId: lineItem.entityId,
            description: lineItem.title ?? lineItem.entityId,
            quantity: lineItem.quantity,
            unitPrice: lineItem.resolvedUnitPrice ?? 0,
            ...(lineItem.discountAmount !== undefined
              ? { discount: lineItem.discountAmount }
              : {}),
          })),
          ...(customerUuid !== undefined
            ? { customerId: customerUuid }
            : {}),
          ...(processed.shippingAddress !== undefined
            ? { toAddress: processed.shippingAddress }
            : {}),
        });
      }

      // Stash paymentMethodId for completeCheckout compensation chain
      context.context.paymentMethodId = processed.paymentMethodId;

      const afterReport = await runAfterHooks(
        afterHooks,
        null,
        order.value,
        "create",
        context,
      );

      await kernel.services.cart.markAsCheckedOut(body.cartId, actor);

      return c.json(
        {
          data: {
            ...order.value,
            // Stripe Elements requires clientSecret to collect card details on the frontend
            ...(processed.paymentClientSecret
              ? { paymentClientSecret: processed.paymentClientSecret }
              : {}),
          },
          meta: afterReport.hasErrors
            ? { hookErrors: afterReport.errors }
            : undefined,
        },
        201,
      );
    } catch (error) {
      // Always log the real error — hidden errors in checkout are unacceptable
      const realMessage = error instanceof Error ? error.message : String(error);
      const realStack = error instanceof Error ? error.stack : undefined;
      console.error("[checkout] Pipeline failed:", { message: realMessage, stack: realStack, code: (error as Record<string, unknown>)?.code });

      const message = isCommerceError(error)
        ? error.message
        : realMessage;
      return c.json(
        {
          error: {
            code: "CHECKOUT_FAILED",
            message,
          },
        },
        422,
      );
    }
  });

  return router;
}
