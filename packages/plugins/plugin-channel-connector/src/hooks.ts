import { resolveOrgId } from "@porulle/core";
import type { PluginHookRegistration } from "@porulle/core";
import { and, eq, inArray } from "@porulle/core/drizzle";
import { sellableEntities } from "@porulle/core/schema";
import {
  ChannelConnectorService,
  type ChannelConnectorPluginOptions,
  type ChannelStockLine,
} from "./service.js";

export function buildHooks(options: ChannelConnectorPluginOptions): PluginHookRegistration[] {
  return [{
    key: "checkout.beforePayment",
    async handler(args: unknown) {
      const { data, context } = args as {
        data: { lineItems: ChannelStockLine[] };
        context: {
          actor: Parameters<typeof resolveOrgId>[0];
          db: ConstructorParameters<typeof ChannelConnectorService>[0];
          services: Record<string, unknown>;
        };
      };
      const service = new ChannelConnectorService(context.db, context.services, options);
      await service.validateLineStock(
        resolveOrgId(context.actor),
        data.lineItems,
        options.inventoryTimeoutMs,
      );
      return data;
    },
  }, {
    key: "orders.afterCreate",
    async handler(args: unknown) {
      const { result, context } = args as {
        result: { id: string; lineItems?: Array<{ entityId: string }> };
        context: { actor: Parameters<typeof resolveOrgId>[0]; db: ConstructorParameters<typeof ChannelConnectorService>[0]; services: Record<string, unknown>; jobs: { enqueue(task: string, input: Record<string, unknown>, options: { organizationId: string; concurrencyKey: string; supersedes: boolean }): Promise<string> } };
      };
      const orgId = resolveOrgId(context.actor);
      const entities = await context.db.select({ id: sellableEntities.id, sourceStoreId: sellableEntities.sourceStoreId }).from(sellableEntities).where(and(eq(sellableEntities.organizationId, orgId), inArray(sellableEntities.id, (result.lineItems ?? []).map((line) => line.entityId))));
      const stores = new Set(entities.map((entity) => entity.sourceStoreId).filter((storeId): storeId is string => storeId !== null));
      await Promise.all([...stores].map((storeId) => context.jobs.enqueue("channel/push-order", { orgId, storeId, orderId: result.id }, { organizationId: orgId, concurrencyKey: `push:${result.id}:${storeId}`, supersedes: true })));
    },
  }];
}
