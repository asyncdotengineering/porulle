import { resolveOrgId } from "@porulle/core";
import type { PluginHookRegistration } from "@porulle/core";
import type { GiftCardService } from "../services/gift-card-service.js";
import type { GiftCardDeduction } from "../types.js";

interface HookContextLike {
  actor: { organizationId?: string | null; [key: string]: unknown } | null;
  [key: string]: unknown;
}

interface CheckoutHookArgs {
  data: {
    total: number;
    currency: string;
    checkoutId: string;
    metadata?: Record<string, unknown>;
  };
  context: HookContextLike;
}

interface AfterCreateHookArgs {
  data: { metadata?: Record<string, unknown>; checkoutId: string };
  result: unknown;
  context: HookContextLike;
}

/**
 * checkout.beforePayment hook — deducts gift card balances before the
 * payment adapter authorizes the remaining amount.
 */
export function buildCheckoutDeductionHook(
  service: GiftCardService,
): PluginHookRegistration {
  const handler = async (args: CheckoutHookArgs) => {
    const { data, context } = args;
    const orgId = resolveOrgId(context.actor);
    const codes = data.metadata?.giftCardCodes as string[] | undefined;
    if (!codes?.length) return data;

    let remaining = data.total;
    const deductions: GiftCardDeduction[] = [];

    for (const code of codes) {
      if (remaining <= 0) break;

      const balanceResult = await service.checkBalance(orgId, code);
      if (!balanceResult.ok) continue;

      const deductAmount = Math.min(remaining, balanceResult.value.balance);
      if (deductAmount <= 0) continue;

      const result = await service.debitWithLock(
        orgId,
        code,
        deductAmount,
        data.checkoutId,
        data.currency,
      );

      if (result.ok) {
        deductions.push(result.value);
        remaining -= deductAmount;
      }
    }

    const giftCardTotal = deductions.reduce((sum, d) => sum + d.amount, 0);

    return {
      ...data,
      total: Math.max(0, remaining),
      metadata: {
        ...data.metadata,
        giftCardDeductions: deductions,
        giftCardTotal,
      },
    };
  };

  return {
    key: "checkout.beforePayment",
    handler: handler as (...args: unknown[]) => unknown,
  };
}

/**
 * checkout.afterCreate hook — compensates gift card deductions if checkout fails.
 */
export function buildCheckoutCompensationHook(
  service: GiftCardService,
): PluginHookRegistration {
  const handler = async (args: AfterCreateHookArgs) => {
    const { data, result, context } = args;
    const orgId = resolveOrgId(context.actor);
    if (!result) {
      const deductions = data.metadata?.giftCardDeductions as
        | GiftCardDeduction[]
        | undefined;

      for (const d of deductions ?? []) {
        await service.creditWithLock(
          orgId,
          d.code,
          d.amount,
          data.checkoutId,
          "Checkout failed — balance restored",
        );
      }
    }
  };

  return {
    key: "checkout.afterCreate",
    handler: handler as (...args: unknown[]) => unknown,
  };
}
