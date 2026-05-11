import { defineCommercePlugin } from "@porulle/core";
import { giftCards, giftCardTransactions } from "./schema.js";
import { GiftCardService } from "./services/gift-card-service.js";
import {
  buildCheckoutDeductionHook,
  buildCheckoutCompensationHook,
} from "./hooks/checkout-deduction.js";
import { buildGiftCardIssuanceHook } from "./hooks/checkout-issuance.js";
import { buildRefundCreditHook } from "./hooks/refund-credit.js";
import { buildAdminRoutes } from "./routes/admin.js";
import { buildPublicRoutes } from "./routes/public.js";
import { buildCustomerRoutes } from "./routes/customer.js";
import type { GiftCardPluginOptions } from "./types.js";
import { DEFAULT_OPTIONS } from "./types.js";

export type { GiftCardPluginOptions } from "./types.js";
export { GiftCardService } from "./services/gift-card-service.js";

export function giftCardPlugin(userOptions: GiftCardPluginOptions = {}) {
  const options: Required<GiftCardPluginOptions> = {
    ...DEFAULT_OPTIONS,
    ...userOptions,
    // Preserve null for defaultExpiryDays when user doesn't set it
    defaultExpiryDays: userOptions.defaultExpiryDays ?? DEFAULT_OPTIONS.defaultExpiryDays,
  };

  return defineCommercePlugin({
    id: "gift-cards",
    version: "1.0.0",

    permissions: [
      {
        scope: "gift-cards:admin",
        description:
          "Create, list, disable, and adjust gift cards. Required for all admin routes.",
      },
    ],

    schema: () => ({
      giftCards,
      giftCardTransactions,
    }),

    hooks: () => {
      // Hooks are registered before the service is available (no DB context).
      // They will be populated with the real service in routes() where ctx is available.
      // For now, return empty — we'll wire them up via a shared reference.
      return [];
    },

    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];

      const service = new GiftCardService(
        db,
        ctx.database.transaction,
        options,
      );

      return [
        ...buildAdminRoutes(service, ctx),
        ...buildPublicRoutes(service, ctx),
        ...buildCustomerRoutes(service, ctx),
      ];
    },
  });
}

/**
 * Standalone factory for the plugin with hooks wired.
 *
 * Since hooks() runs before routes() (no DB context), we use a deferred
 * service pattern: hooks capture a shared reference that gets populated
 * when routes() runs with the real DB.
 */
export function giftCardPluginWithHooks(
  userOptions: GiftCardPluginOptions = {},
) {
  const options: Required<GiftCardPluginOptions> = {
    ...DEFAULT_OPTIONS,
    ...userOptions,
    defaultExpiryDays: userOptions.defaultExpiryDays ?? DEFAULT_OPTIONS.defaultExpiryDays,
  };

  // Shared mutable reference — populated when routes() runs
  const serviceRef: { current: GiftCardService | null } = { current: null };

  return defineCommercePlugin({
    id: "gift-cards",
    version: "1.0.0",

    permissions: [
      {
        scope: "gift-cards:admin",
        description:
          "Create, list, disable, and adjust gift cards. Required for all admin routes.",
      },
    ],

    schema: () => ({
      giftCards,
      giftCardTransactions,
    }),

    hooks: () => {
      // Lazy proxy: defers to serviceRef.current once routes() initializes it.
      // Uses Reflect.get for type-safe dynamic property access (no index signature needed).
      const lazyService = new Proxy({} as GiftCardService, {
        get(_target, prop, receiver) {
          if (!serviceRef.current) {
            throw new Error(
              "Gift card service not initialized — hooks ran before routes()",
            );
          }
          return Reflect.get(serviceRef.current, prop, receiver);
        },
      });

      return [
        buildCheckoutDeductionHook(lazyService),
        buildCheckoutCompensationHook(lazyService),
        buildGiftCardIssuanceHook(lazyService, options),
        buildRefundCreditHook(lazyService),
      ];
    },

    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];

      const service = new GiftCardService(
        db,
        ctx.database.transaction,
        options,
      );

      // Wire up the shared reference so hooks can access the service
      serviceRef.current = service;

      return [
        ...buildAdminRoutes(service, ctx),
        ...buildPublicRoutes(service, ctx),
        ...buildCustomerRoutes(service, ctx),
      ];
    },
  });
}
