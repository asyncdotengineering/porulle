import { resolveOrgId } from "@porulle/core";
import type { PluginHookRegistration } from "@porulle/core";
import type { GiftCardService } from "../services/gift-card-service.js";
import type { GiftCardPluginOptions } from "../types.js";

interface OrderLineItem {
  entityId: string;
  entityType?: string;
  quantity: number;
  unitPrice?: number;
  totalPrice?: number;
}

interface OrderResult {
  id: string;
  customerId?: string | null;
  currency: string;
  lineItems?: OrderLineItem[];
  metadata?: Record<string, unknown> | null;
}

interface HookContextLike {
  actor: { organizationId?: string | null; [key: string]: unknown } | null;
  [key: string]: unknown;
}

interface AfterCreateHookArgs {
  data: unknown;
  result: OrderResult | null;
  context: HookContextLike;
}

/**
 * checkout.afterCreate hook — issues gift cards when a gift card product is purchased.
 */
export function buildGiftCardIssuanceHook(
  service: GiftCardService,
  options: Required<GiftCardPluginOptions>,
  enqueueJob?: (slug: string, input: Record<string, unknown>) => Promise<string>,
): PluginHookRegistration {
  const handler = async (args: AfterCreateHookArgs) => {
    const { result, context } = args;
    if (!result?.lineItems) return;

    const orgId = resolveOrgId(context.actor);

    for (const item of result.lineItems) {
      if (item.entityType !== options.productType) continue;

      const amount = item.totalPrice ?? (item.unitPrice ?? 0) * item.quantity;
      if (amount <= 0) continue;

      const orderMeta = result.metadata as Record<string, unknown> | null;
      const recipientEmail = (orderMeta?.giftCardRecipientEmail as string) ?? undefined;
      const senderName = (orderMeta?.giftCardSenderName as string) ?? undefined;
      const personalMessage = (orderMeta?.giftCardPersonalMessage as string) ?? undefined;

      const createInput: Parameters<typeof service.create>[1] = {
        amount,
        currency: result.currency,
        sourceOrderId: result.id,
      };
      if (result.customerId) createInput.purchaserId = result.customerId;
      if (recipientEmail) createInput.recipientEmail = recipientEmail;
      if (senderName) createInput.senderName = senderName;
      if (personalMessage) createInput.personalMessage = personalMessage;

      const cardResult = await service.create(orgId, createInput);

      if (cardResult.ok && enqueueJob && recipientEmail) {
        try {
          await enqueueJob("gift-card.deliver", {
            giftCardId: cardResult.value.id,
            code: cardResult.value.code,
            amount,
            currency: result.currency,
            recipientEmail,
            senderName: senderName ?? "",
            personalMessage: personalMessage ?? "",
            template: options.emailTemplate,
          });
        } catch {
          // Email delivery failure should not break checkout
        }
      }
    }
  };

  return {
    key: "checkout.afterCreate",
    handler: handler as (...args: unknown[]) => unknown,
  };
}
