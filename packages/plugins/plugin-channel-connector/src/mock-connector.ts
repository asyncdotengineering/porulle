import {
  CommerceValidationError,
  Err,
  Ok,
  defineChannelConnector,
} from "@porulle/core";
import type {
  ChannelCatalogItem,
  ChannelInventoryLevel,
  ChannelOrderSlice,
} from "@porulle/core";

export interface MockChannelConnectorOptions {
  catalog?: ChannelCatalogItem[];
  inventory?: ChannelInventoryLevel[];
  inventoryError?: Error;
  throwOnInventory?: boolean;
  inventoryDelayMs?: number;
  onFetchInventory?: (ids: string[]) => void;
}

export function mockChannelConnector(options: MockChannelConnectorOptions = {}) {
  const orders = new Map<string, ChannelOrderSlice>();

  return defineChannelConnector({
    providerId: "mock",
    capabilities: {
      importCatalog: true,
      importInventory: true,
      pushOrder: true,
      receiveWebhooks: true,
    },
    async importCatalog() {
      return Ok({ items: options.catalog ?? [], nextCursor: null });
    },
    async fetchInventory(_store, ids) {
      const requestedIds = ids ?? [];
      options.onFetchInventory?.(requestedIds);
      if (options.inventoryDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.inventoryDelayMs));
      }
      if (options.throwOnInventory) throw new Error("Mock inventory failure.");
      if (options.inventoryError) return Err(new CommerceValidationError(options.inventoryError.message));
      const inventory = options.inventory ?? [];
      return Ok(ids ? inventory.filter((item) => ids.includes(item.externalId)) : inventory);
    },
    async pushOrder(_store, slice) {
      const remoteOrderId = `mock-order-${orders.size + 1}`;
      orders.set(remoteOrderId, structuredClone(slice));
      return Ok({
        remoteOrderId,
        remoteUrl: `https://mock.channel.test/orders/${remoteOrderId}`,
      });
    },
    async fetchOrderStatus(_store, remoteId) {
      if (!orders.has(remoteId)) {
        return Err(new CommerceValidationError(`Mock order "${remoteId}" was not found.`));
      }
      return Ok({ status: "confirmed" as const });
    },
    async verifyWebhook(store, request) {
      if (request.headers.get("x-mock-signature") !== store.webhookSecret) {
        return Err(new CommerceValidationError("Invalid mock webhook signature."));
      }
      let data: { id?: string; type?: string; data?: unknown };
      try {
        data = await request.json() as typeof data;
      } catch {
        return Err(new CommerceValidationError("Mock webhook body must be valid JSON."));
      }
      if (!data.id || !data.type) {
        return Err(new CommerceValidationError("Mock webhook requires id and type."));
      }
      return Ok({ id: data.id, type: data.type, data: data.data });
    },
    async refundExecute() {
      return Err(new CommerceValidationError(
        "Channel refund execution is not implemented in the foundations slice.",
      ));
    },
  });
}
