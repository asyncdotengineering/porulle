import { defineChannelConnector, Err, Ok } from "@porulle/core";
import type { ChannelConnector, ChannelConnectorError, ChannelStore, Result } from "@porulle/core";
import { z } from "zod";
import { catalogItems, importPage, storeProfile } from "./catalog.js";
import { pushCatalog, pushCaches } from "./catalog-push.js";
import { discoverStore, normalizeStoreDomain, wooClient, wooCredentialsSchema } from "./client.js";
import type { WooClient, WooTransportOptions } from "./client.js";
import { inventoryFor, inventoryPage } from "./inventory.js";
import { cancelOrder, orderStatus, pushOrder } from "./orders.js";
import { decodeDelivery, orderEvents, registerWebhooks, unregisterWebhooks, verifyDelivery, webhookHealth, WOO_WEBHOOK_TOPICS } from "./webhooks.js";

export { normalizeStoreDomain, probeStore, refusedStoreUrl, WOO_BLOCKED_BY_FIREWALL } from "./client.js";
export type { WooCredentials, WooProbeFailure } from "./client.js";
export { ORDER_META_KEY } from "./orders.js";
export { WOO_WEBHOOK_TOPICS } from "./webhooks.js";

export interface WooConnectorOptions {
  fetchImpl?: typeof fetch;
  /** Sent on every request: a store's firewall can then allow us by name. */
  userAgent?: string;
  /** Only for a test store on localhost; production stores are public https sites. */
  allowPrivateHosts?: boolean;
  /** How many units a product the store does not count (`manage_stock: false`) can sell while in stock. */
  untrackedStockQuantity?: number;
  /** How the store's order (and the email it sends the shopper) names the payment. */
  paymentMethodTitle?: string;
  /** The application name WooCommerce shows the merchant on its approval screen. */
  appName?: string;
}

/** What WooCommerce posts to the callback when the merchant approves: keys, and our own `user_id` back. */
const authCallbackSchema = z.object({
  key_id: z.union([z.number(), z.string()]).optional(),
  user_id: z.union([z.string(), z.number()]).transform(String),
  consumer_key: z.string(),
  consumer_secret: z.string(),
  key_permissions: z.string(),
});

const refused = (code: string, message: string): Result<never, ChannelConnectorError> => Err({ code, message, retriable: false });

export function wooConnector(options: WooConnectorOptions = {}): ChannelConnector {
  const transport: WooTransportOptions = {
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
    userAgent: options.userAgent ?? "Porulle-WooCommerce/1.0",
    allowPrivateHosts: options.allowPrivateHosts === true,
  };
  const untracked = options.untrackedStockQuantity ?? 99;
  const caches = pushCaches();
  const withClient = async <T>(store: ChannelStore, call: (client: WooClient) => Promise<Result<T, ChannelConnectorError>>): Promise<Result<T, ChannelConnectorError>> => {
    const client = wooClient(store, transport);
    return client.ok ? call(client.value) : client;
  };

  return defineChannelConnector({
    providerId: "woocommerce",
    capabilities: { importCatalog: true, importInventory: true, pushOrder: true, pushCatalog: true, receiveWebhooks: true },
    webhookTopics: WOO_WEBHOOK_TOPICS,
    normalizeStoreDomain: (input) => normalizeStoreDomain(input, { allowPrivateHosts: transport.allowPrivateHosts }),
    buildAuthUrl(params) {
      const store = normalizeStoreDomain(params.storeDomain, { allowPrivateHosts: transport.allowPrivateHosts });
      if (!store) return refused("WOO_INVALID_STORE_DOMAIN", "A WooCommerce store is named by its https address.");
      let callback: URL;
      try {
        callback = new URL(params.callbackUri);
      } catch {
        return refused("WOO_INVALID_CALLBACK_URL", "WooCommerce needs an https callback address.");
      }
      if (callback.protocol !== "https:") return refused("WOO_INVALID_CALLBACK_URL", "WooCommerce needs an https callback address.");
      callback.searchParams.set("state", params.state);
      const returnUrl = new URL(params.callbackUri);
      returnUrl.searchParams.set("state", params.state);
      returnUrl.searchParams.set("return", "1");
      const url = new URL(`${store}/wc-auth/v1/authorize`);
      url.searchParams.set("app_name", options.appName ?? "Runvae");
      url.searchParams.set("scope", "read_write");
      // Echoed back in the posted keys: the keys are bound to the connection this state started.
      url.searchParams.set("user_id", params.state);
      url.searchParams.set("return_url", returnUrl.toString());
      url.searchParams.set("callback_url", callback.toString());
      return Ok(url.toString());
    },
    /**
     * The keys WooCommerce posts. They carry no store address and no signature, so they are accepted
     * only for the connection they were issued for (`user_id` is our state), only read-write, only
     * in WooCommerce's key format. Any refusal answers non-200, and WooCommerce deletes the key.
     */
    async completeAuth(request, ctx) {
      if (request.method !== "POST") return refused("WOO_AUTH_METHOD_REQUIRED", "WooCommerce posts the keys.");
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return refused("WOO_AUTH_RESPONSE_INVALID", "WooCommerce's callback body was not JSON.");
      }
      const body = authCallbackSchema.safeParse(raw);
      if (!body.success) return refused("WOO_AUTH_RESPONSE_INVALID", "WooCommerce's callback did not carry keys.");
      if (body.data.user_id !== ctx.state) return refused("WOO_AUTH_STATE_MISMATCH", "The keys were issued for another connection.");
      if (body.data.key_permissions !== "read_write") return refused("WOO_AUTH_READ_ONLY", "The store granted read-only access; we need read and write to send orders.");
      const credentials = wooCredentialsSchema.safeParse({ consumerKey: body.data.consumer_key, consumerSecret: body.data.consumer_secret });
      if (!credentials.success) return refused("WOO_AUTH_CREDENTIALS_INVALID", "The keys WooCommerce sent are not in its key format.");
      return Ok({ credentials: { ...credentials.data }, storeDomain: ctx.storeDomain });
    },
    /**
     * Learns, once, how to call the store (where its REST API answers, how it accepts our keys, how it
     * prices) and hands it to the plugin to persist. Forced after a rejected key: a host that began
     * stripping the Authorization header is met in query mode; a key both modes refuse is gone.
     */
    async liveCredentials(store, refresh) {
      const credentials = wooCredentialsSchema.safeParse(store.credentials);
      if (!credentials.success) return refused("WOO_CREDENTIALS_REQUIRED", "The store holds no valid WooCommerce keys; it must be reconnected.");
      const known = credentials.data;
      if (refresh?.force !== true && known.authMode && known.restRoute && known.currency && known.priceDecimals !== undefined) return Ok(null);
      const discovered = await discoverStore(transport, store.storeDomain, known);
      if (!discovered.ok) return discovered;
      return Ok({ ...store.credentials, ...discovered.value });
    },
    async fetchStoreProfile(store) {
      return withClient(store, storeProfile);
    },
    async importCatalog(store, cursor) {
      return withClient(store, (client) => importPage(client, cursor));
    },
    async fetchCatalogItems(store, externalIds) {
      return withClient(store, (client) => catalogItems(client, externalIds));
    },
    async fetchInventory(store, ids) {
      return withClient(store, async (client) => {
        if (ids !== undefined) return inventoryFor(client, ids, untracked);
        const levels = [];
        let cursor: string | null = null;
        do {
          const page: Awaited<ReturnType<typeof inventoryPage>> = await inventoryPage(client, cursor, untracked);
          if (!page.ok) return page;
          levels.push(...page.value.levels);
          cursor = page.value.nextCursor;
        } while (cursor !== null);
        return Ok(levels);
      });
    },
    async fetchInventoryPage(store, cursor) {
      return withClient(store, (client) => inventoryPage(client, cursor, untracked));
    },
    async pushOrder(store, slice) {
      return withClient(store, (client) => pushOrder(client, slice, { paymentMethodTitle: options.paymentMethodTitle ?? "Paid on Runvae", untrackedStockQuantity: untracked }));
    },
    async fetchOrderStatus(store, remoteId) {
      return withClient(store, (client) => orderStatus(client, remoteId));
    },
    async cancelOrder(store, remoteId, input) {
      return withClient(store, (client) => cancelOrder(client, remoteId, input));
    },
    async pushCatalog(store, items, opts) {
      return withClient(store, (client) => pushCatalog(client, store, items, opts, caches));
    },
    async verifyWebhook(store, request) {
      return verifyDelivery(store, request);
    },
    async decodeWebhook(store, event) {
      return withClient(store, (client) => decodeDelivery(client, event, untracked));
    },
    async registerWebhooks(store, topics, callbackUrl) {
      return withClient(store, (client) => registerWebhooks(client, store, topics, callbackUrl));
    },
    async unregisterWebhooks(store, callbackUrl) {
      return withClient(store, (client) => unregisterWebhooks(client, callbackUrl));
    },
    async orderEvents(store, remoteOrderId) {
      return withClient(store, (client) => orderEvents(client, remoteOrderId));
    },
    async webhookHealth(store, callbackUrl) {
      return withClient(store, (client) => webhookHealth(client, store, WOO_WEBHOOK_TOPICS, callbackUrl));
    },
    async refundExecute() {
      return refused("NOT_IMPLEMENTED", "Refunds are issued by the platform, not executed in the WooCommerce store.");
    },
  });
}
