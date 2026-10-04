import {
  CommerceValidationError,
  Err,
  Ok,
  defineChannelConnector,
} from "@porulle/core";
import { z } from "zod";
import type {
  ChannelCatalogItem,
  ChannelEvent,
  ChannelConnectorError,
  ChannelInventoryLevel,
  ChannelOrderSlice,
  ChannelPushCatalogItem,
  ChannelPushCatalogPreviousField,
  ChannelStore,
} from "@porulle/core";

export interface MockChannelConnectorOptions {
  catalog?: ChannelCatalogItem[];
  inventory?: ChannelInventoryLevel[];
  inventoryError?: Error;
  throwOnInventory?: boolean;
  inventoryDelayMs?: number;
  onFetchInventory?: (ids: string[]) => void;
  pushCatalogFailures?: Record<string, ChannelConnectorError>;
  pushCatalogTransportError?: ChannelConnectorError;
  onPushCatalog?: (items: ChannelPushCatalogItem[]) => void;
}

const defaultCatalog: ChannelCatalogItem[] = [{
  externalId: "mock-product-1",
  slug: "mock-channel-product",
  title: "Mock Channel Product",
  description: "Imported through the mock connector.",
  attributes: [{
    locale: "en",
    title: "Mock Channel Product",
    subtitle: "A complete mock catalog item",
    description: "Imported through the mock connector.",
    richDescription: { blocks: [{ type: "paragraph", text: "Mock product details." }] },
    seoTitle: "Mock Channel Product | Porulle",
    seoDescription: "A mock product with the complete channel catalog shape.",
  }],
  images: [
    {
      externalId: "mock-image-primary",
      url: "https://mock.channel.test/images/mock-product-1-primary.jpg",
      alt: "Mock Channel Product",
      role: "primary",
      sortOrder: 0,
    },
    {
      externalId: "mock-image-variant",
      url: "https://mock.channel.test/images/mock-variant-1.jpg",
      alt: "Mock Channel Product blue variant",
      role: "gallery",
      sortOrder: 1,
      variantExternalIds: ["mock-variant-1"],
    },
  ],
  options: [{
    name: "color",
    displayName: "Color",
    sortOrder: 0,
    values: [{ value: "blue", displayValue: "Blue", sortOrder: 0 }],
  }],
  tags: ["mock", "featured"],
  brand: "Porulle",
  categories: ["mock-products"],
  status: "active",
  variants: [{
    externalId: "mock-variant-1",
    sku: "MOCK-SKU-1",
    barcode: "0123456789012",
    optionValues: { color: "blue" },
    prices: [{ currency: "USD", amount: 2500 }],
  }],
}];

const level = z.object({ externalId: z.string(), available: z.number() });
const shipment = z.object({
  remoteId: z.string(),
  carrier: z.string().exactOptional(),
  trackingNumber: z.string().exactOptional(),
  trackingUrl: z.string().exactOptional(),
  lines: z.array(z.object({ externalVariantId: z.string(), quantity: z.number().int() })),
  source: z.string().exactOptional(),
});
/** A mock delivery's body IS what it means: one {@link ChannelEvent} or a list of them. */
const channelEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product.changed"), externalIds: z.array(z.string()) }),
  z.object({ kind: z.literal("product.deleted"), externalIds: z.array(z.string()) }),
  z.object({ kind: z.literal("inventory.changed"), levels: z.array(level) }),
  z.object({ kind: z.literal("order.cancelled"), remoteOrderId: z.string() }),
  z.object({ kind: z.literal("order.fulfilled"), remoteOrderId: z.string(), partial: z.boolean(), shipments: z.array(shipment) }),
  z.object({ kind: z.literal("refund.created"), remoteOrderId: z.string(), remoteRefundId: z.string(), lines: z.array(z.object({ externalVariantId: z.string(), quantity: z.number().int() })), amount: z.number().int().exactOptional() }),
  z.object({ kind: z.literal("return.updated"), remoteReturnId: z.string(), status: z.enum(["approved", "declined", "closed", "cancelled"]) }),
  z.object({ kind: z.literal("connection.revoked") }),
  z.object({ kind: z.literal("compliance.request"), request: z.enum(["customer_data", "customer_redact", "shop_redact"]), data: z.record(z.string(), z.unknown()) }),
]) satisfies z.ZodType<ChannelEvent>;

export function mockChannelConnector(options: MockChannelConnectorOptions = {}) {
  const orders = new Map<string, ChannelOrderSlice>();
  const catalog = new Map<string, ChannelPushCatalogItem>();

  return defineChannelConnector({
    providerId: "mock",
    capabilities: {
      importCatalog: true,
      importInventory: true,
      pushOrder: true,
      pushCatalog: true,
      receiveWebhooks: true,
    },
    async importCatalog(_store?: ChannelStore) {
      return Ok({ items: options.catalog ?? defaultCatalog, nextCursor: null });
    },
    /** The catalogue as it stands when asked: a test changes `options.catalog` to change "the store". */
    async fetchCatalogItems(_store, externalIds) {
      const wanted = new Set(externalIds);
      return Ok((options.catalog ?? defaultCatalog).filter((item) => wanted.has(item.externalId)));
    },
    async decodeWebhook(_store, event) {
      const parsed = z.union([channelEventSchema, z.array(channelEventSchema)]).safeParse(event.data);
      if (!parsed.success) return Err({ code: "MOCK_WEBHOOK_MALFORMED", message: parsed.error.message, retriable: false });
      return Ok(Array.isArray(parsed.data) ? parsed.data : [parsed.data]);
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
      // Derived from the order, not counted: the count lived in this in-memory Map, which every
      // Worker isolate starts empty, so two different orders both came back as mock-order-1.
      const remoteOrderId = `mock-order-${slice.orderId}`;
      orders.set(remoteOrderId, structuredClone(slice));
      return Ok({
        remoteOrderId,
        remoteUrl: `https://mock.channel.test/orders/${remoteOrderId}`,
      });
    },
    async pushCatalog(_store, items, opts?: { dryRun?: boolean }) {
      if (options.pushCatalogTransportError) return Err(options.pushCatalogTransportError);
      const outcomes = items.map((item) => {
        const error = options.pushCatalogFailures?.[item.externalId];
        if (error) return { externalId: item.externalId, ok: false, error };
        const previous = catalog.get(item.externalId);
        const previousFields: ChannelPushCatalogPreviousField[] = previous
          ? [...previous.fields, ...(previous.variants ?? []).flatMap((variant) => variant.fields)]
            .map((field) => ({ fieldPath: field.fieldPath, value: structuredClone(field.value) }))
          : [];
        if (opts?.dryRun !== true) catalog.set(item.externalId, structuredClone(item));
        return {
          externalId: item.externalId,
          ok: true,
          ...(previousFields.length > 0 ? { previousFields } : {}),
        };
      });
      if (opts?.dryRun !== true) options.onPushCatalog?.(structuredClone(items));
      return Ok({ outcomes });
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
