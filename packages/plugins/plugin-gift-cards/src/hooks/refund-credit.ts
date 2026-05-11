import { resolveOrgId } from "@porulle/core";
import type { PluginHookRegistration } from "@porulle/core";
import type { GiftCardService } from "../services/gift-card-service.js";
import type { GiftCardDeduction } from "../types.js";

interface HookContextLike {
  actor: { organizationId?: string | null; [key: string]: unknown } | null;
  [key: string]: unknown;
}

interface OrderUpdateHookArgs {
  data: unknown;
  result: {
    id: string;
    status?: string;
    metadata?: Record<string, unknown> | null;
  } | null;
  context: HookContextLike;
}

/**
 * order.afterUpdate hook — restores gift card balances when an order is refunded.
 */
export function buildRefundCreditHook(
  service: GiftCardService,
): PluginHookRegistration {
  const handler = async (args: OrderUpdateHookArgs) => {
    const { result, context } = args;
    if (!result) return;

    const status = result.status;
    if (status !== "refunded" && status !== "cancelled") return;

    const deductions = result.metadata?.giftCardDeductions as
      | GiftCardDeduction[]
      | undefined;

    if (!deductions?.length) return;

    const orgId = resolveOrgId(context.actor);
    for (const d of deductions) {
      await service.creditWithLock(
        orgId,
        d.code,
        d.amount,
        result.id,
        `Order ${status} — balance restored`,
      );
    }
  };

  return {
    key: "order.afterUpdate",
    handler: handler as (...args: unknown[]) => unknown,
  };
}
