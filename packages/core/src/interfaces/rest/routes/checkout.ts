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
import { assertPermission } from "../../../auth/permissions.js";
import { makeId } from "../../../utils/id.js";
import type { ShippingAddress } from "../../../modules/shipping/calculator.js";
import type { Actor } from "../../../auth/types.js";

/**
 * SEC-07 — resolve the customer profile a checkout order is attributed to.
 * A self-service actor may ONLY attribute the order to its own customer
 * profile; only actors with org-level `customers:read` (staff/clienteling) may
 * name an arbitrary `customerId`. Returns undefined for guests / unresolved
 * (guest checkout). Exported for unit testing.
 */
export async function resolveCheckoutCustomerUuid(
  customers: Kernel["services"]["customers"],
  actor: Actor | null,
  customerId: string | undefined,
): Promise<string | undefined> {
  const actorUserId = actor?.userId;
  let canActForOthers = false;
  if (actorUserId) {
    try {
      assertPermission(actor, "customers:read");
      canActForOthers = true;
    } catch {
      canActForOthers = false;
    }
  }

  if (customerId) {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidRe.test(customerId)) {
      const byId = await customers.getById(customerId, actor);
      // Honor a profile UUID only if it is the actor's own, or the actor may
      // act for other customers.
      if (byId.ok && (canActForOthers || byId.value.userId === actorUserId)) {
        return byId.value.id;
      }
    }
    if (canActForOthers) {
      // Staff may resolve/create a customer by a supplied user_id.
      const byUser = await customers.getByUserId(customerId, actor);
      if (byUser.ok) return byUser.value.id;
    }
  }

  // Self-service default: the authenticated actor's own customer profile.
  if (actorUserId && !canActForOthers) {
    const own = await customers.getByUserId(actorUserId, actor);
    if (own.ok) return own.value.id;
  }
  return undefined;
}

export function checkoutRoutes(kernel: Kernel) {
  const router = new OpenAPIHono<AppEnv>();

  // @ts-expect-error -- openapi() enforces strict response typing but our handler
  // returns union responses (201 | 400 | 422). The route definition documents the
  // contract; the defaultHook handles Zod validation; the handler returns dynamic status.
  router.openapi(checkoutRoute, async (c) => {
    const body = c.req.valid("json");

    const actor = c.get("actor");

    // Idempotent replay: a re-submitted checkout (offline POS queue, network
    // retry) returns the already-created order BEFORE the pipeline runs — no
    // double payment authorization, no duplicate order.
    if (body.idempotencyKey) {
      const replay = await kernel.services.orders.getByIdempotencyKey(
        body.idempotencyKey,
        actor,
      );
      if (replay.ok && replay.value) {
        // IDOR guard: an idempotency key must only replay the requester's OWN
        // order. Without this, a same-org customer who supplies/guesses another
        // customer's key would receive that customer's order (PII, totals, lines).
        let canActForOthers = false;
        try {
          assertPermission(actor, "customers:read");
          canActForOthers = true;
        } catch {
          canActForOthers = false;
        }
        const ownCustomer = actor
          ? await resolveCheckoutCustomerUuid(kernel.services.customers, actor, undefined)
          : undefined;
        const replayCustomer = replay.value.customerId ?? null;
        const ownsOrder =
          (replayCustomer !== null && replayCustomer === ownCustomer) ||
          (replayCustomer === null && !ownCustomer);
        if (canActForOthers || ownsOrder) {
          return c.json({ data: replay.value }, 201);
        }
        return c.json(
          {
            error: {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Idempotency key does not belong to this account.",
            },
          },
          409,
        );
      }
    }

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

      // SEC-07: resolve the order's customer server-side. A self-service actor
      // can only attribute the order to its own profile; a client-supplied
      // foreign customerId is ignored unless the actor is staff.
      const customerUuid = await resolveCheckoutCustomerUuid(
        kernel.services.customers,
        actor,
        processed.customerId,
      );

      const orderPayload = {
        ...(body.idempotencyKey !== undefined
          ? { idempotencyKey: body.idempotencyKey }
          : {}),
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
            // Per-line tax from product tax classes (issue #57)
            taxAmount: lineItem.taxAmount ?? 0,
            ...(lineItem.discountAmount !== undefined
              ? { discountAmount: lineItem.discountAmount }
              : {}),
          };
          return lineItem.variantId !== undefined
            ? { ...payload, variantId: lineItem.variantId }
            : payload;
        }),
        ...(customerUuid !== undefined
          ? { customerId: customerUuid }
          : {}),
      };

      // Checkout is a trusted, already-server-priced pipeline (resolveCurrentPrices
      // + promotions/tax) and reserves stock in its own after-hooks — so it hands
      // the order primitive precomputed totals rather than re-deriving them.
      const order = await kernel.services.orders.create(orderPayload, actor, undefined, {
        trustedPricing: true,
      });

      if (!order.ok) {
        return c.json(
          mapErrorToResponse(order.error),
          mapErrorToStatus(order.error),
        );
      }

      if (order.ok && (processed.appliedPromotions?.length ?? 0) > 0) {
        await kernel.services.promotions.recordUsage({
          promotions: processed.appliedPromotions ?? [],
          organizationId: order.value.organizationId,
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
