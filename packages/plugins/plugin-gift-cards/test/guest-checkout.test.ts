import { beforeAll, describe, expect, it } from "vitest";
import {
  createHookContext,
  runBeforeHooks,
  type BeforeHook,
  type PluginDb,
} from "@porulle/core";
import { createPluginTestApp } from "@porulle/core/testing";
import type { PluginTestApp } from "@porulle/core/testing";
import { giftCardPluginWithHooks } from "../src/index.js";

interface GuestCheckoutData {
  total: number;
  currency: string;
  checkoutId: string;
  metadata?: Record<string, unknown>;
}

describe("gift-card checkout hook", () => {
  let built: PluginTestApp;

  beforeAll(async () => {
    built = await createPluginTestApp(giftCardPluginWithHooks());
  }, 30_000);

  it("allows a guest checkout without gift-card codes on a default-org deployment", async () => {
    const data: GuestCheckoutData = {
      total: 2500,
      currency: "USD",
      checkoutId: "guest-checkout-without-gift-card",
    };
    const context = createHookContext({
      actor: null,
      logger: built.kernel.logger,
      services: built.kernel.services,
      context: { moduleName: "checkout" },
      origin: "rest",
      database: { db: built.kernel.database.db as PluginDb },
      commerceConfig: built.kernel.config,
    });
    const hooks = built.kernel.hooks.resolve(
      "checkout.beforePayment",
    ) as BeforeHook<GuestCheckoutData>[];

    await expect(runBeforeHooks(hooks, data, "create", context)).resolves.toEqual(data);
  });
});
