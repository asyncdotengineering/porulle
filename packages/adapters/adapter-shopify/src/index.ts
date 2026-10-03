import { createHmac, timingSafeEqual } from "node:crypto";
import { defineChannelConnector, Err, Ok } from "@porulle/core";
import type {
  ChannelConnector,
  ChannelConnectorError,
  ChannelInventoryLevel,
  ChannelOrderSlice,
  ChannelOrderStatus,
  ChannelStore,
  ChannelStoreProfile,
  Result,
} from "@porulle/core";
import { z } from "zod";
import { readCatalogItems, readCatalogPage } from "./catalog.js";
import { shopifyGid, shopifyGraphql } from "./graphql.js";
import type { ShopifyGraphqlTarget } from "./graphql.js";
import {
  REQUIRED_SCOPES,
  buildAuthorizeUrl,
  exchangeCallback,
  normalizeShopDomain,
  parseShopifyCredentials,
  refreshIfExpiring,
  validShopDomain,
} from "./oauth.js";

export { SHOPIFY_API_VERSION } from "./graphql.js";
export { CATALOG_ITEMS_QUERY, CATALOG_PAGE_QUERY, VARIANTS_PAGE_QUERY } from "./catalog.js";
export { REQUIRED_SCOPES, normalizeShopDomain, parseShopifyCredentials } from "./oauth.js";
export type { ShopifyCredentials } from "./oauth.js";

export interface ShopifyConnectorOptions {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  /**
   * Where a shop's Admin API lives. Production omits it: `https://{shop}`. A test points it at a
   * stand-in that serves every shop under its own path — `(shop) => \`${mock}/shopify/${shop}\`` —
   * so the shop's identity still rides in the request exactly as it does in production, and the
   * code exercised by a test is the code that runs. There is no mock flag inside this adapter.
   */
  shopOrigin?: (shopDomain: string) => string;
}

export const INVENTORY_QUERY = `query PorulleInventoryPage($after: String) {
  productVariants(first: 250, after: $after, sortKey: ID) { pageInfo { hasNextPage endCursor } nodes { legacyResourceId inventoryQuantity } }
}`;

export const VARIANT_INVENTORY_QUERY = `query PorulleVariantInventory($ids: [ID!]!) {
  nodes(ids: $ids) { ... on ProductVariant { legacyResourceId inventoryQuantity } }
}`;

export const STORE_PROFILE_QUERY = `query PorulleStoreProfile {
  shop { name currencyCode myshopifyDomain primaryDomain { host } }
}`;

export const ORDER_CREATE_MUTATION = `mutation PorulleOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) { order { legacyResourceId } userErrors { field message } }
}`;

export const ORDER_BY_SOURCE_QUERY = `query PorulleOrderBySource($query: String!) {
  orders(first: 1, query: $query) { nodes { legacyResourceId } }
}`;

export const ORDER_STATUS_QUERY = `query PorulleOrderStatus($id: ID!) {
  order(id: $id) { cancelledAt displayFinancialStatus displayFulfillmentStatus }
}`;

const inventoryLevelSchema = z.object({ legacyResourceId: z.string(), inventoryQuantity: z.number().nullable() });
const inventoryPageSchema = z.object({
  productVariants: z.object({ pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }), nodes: z.array(inventoryLevelSchema) }),
});
const variantInventorySchema = z.object({ nodes: z.array(z.union([inventoryLevelSchema, z.object({}).strict(), z.null()])) });
const storeProfileSchema = z.object({
  shop: z.object({ name: z.string(), currencyCode: z.string(), myshopifyDomain: z.string(), primaryDomain: z.object({ host: z.string() }) }),
});
const orderCreateSchema = z.object({
  orderCreate: z.object({
    order: z.object({ legacyResourceId: z.string() }).nullable(),
    userErrors: z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() })),
  }),
});
const orderBySourceSchema = z.object({ orders: z.object({ nodes: z.array(z.object({ legacyResourceId: z.string() })) }) });
const orderStatusSchema = z.object({
  order: z.object({ cancelledAt: z.string().nullable(), displayFinancialStatus: z.string().nullable(), displayFulfillmentStatus: z.string() }).nullable(),
});

const SOURCE_NAME = "porulle";

type VariantLevel = z.infer<typeof inventoryLevelSchema>;

/** `nodes` answers null for a deleted id and `{}` for an id of another type; neither is a level. */
function isVariantLevel(node: VariantLevel | Record<string, never> | null): node is VariantLevel {
  return node !== null && typeof node.legacyResourceId === "string";
}

/** Stock is never negative here: an oversold variant reads as none available. */
function level(node: z.infer<typeof inventoryLevelSchema>): ChannelInventoryLevel {
  return { externalId: node.legacyResourceId, available: Math.max(0, node.inventoryQuantity ?? 0) };
}

function money(minor: number, currency: string): { shopMoney: { amount: string; currencyCode: string } } {
  return { shopMoney: { amount: (minor / 100).toFixed(2), currencyCode: currency } };
}

function orderStatus(order: NonNullable<z.infer<typeof orderStatusSchema>["order"]>): ChannelOrderStatus {
  if (order.cancelledAt) return { status: "cancelled" };
  if (order.displayFulfillmentStatus === "FULFILLED") return { status: "fulfilled" };
  if (order.displayFinancialStatus === "PAID" || order.displayFinancialStatus === "PARTIALLY_PAID") return { status: "confirmed" };
  if (order.displayFinancialStatus === "REFUNDED" || order.displayFinancialStatus === "VOIDED") return { status: "failed" };
  return { status: "pending" };
}

function validBase64Hmac(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const credentialsRequired: ChannelConnectorError = { code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "The store holds no Shopify access token; it must be reconnected.", retriable: false };

export function shopifyConnector(options: ShopifyConnectorOptions): ChannelConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = (shopDomain: string): string => options.shopOrigin?.(shopDomain) ?? `https://${shopDomain}`;
  const target = (store: ChannelStore): ShopifyGraphqlTarget | undefined => {
    const credentials = parseShopifyCredentials(store.credentials);
    return credentials ? { fetchImpl, origin: origin(store.storeDomain), accessToken: credentials.accessToken } : undefined;
  };

  return defineChannelConnector({
    providerId: "shopify",
    capabilities: { importCatalog: true, importInventory: true, pushOrder: true, receiveWebhooks: true },
    normalizeStoreDomain: normalizeShopDomain,
    buildAuthUrl(params) {
      const shop = params.storeDomain.toLowerCase();
      if (!validShopDomain(shop)) return Err({ code: "SHOPIFY_INVALID_STORE_DOMAIN", message: "A Shopify store is named by its *.myshopify.com domain.", retriable: false });
      return Ok(buildAuthorizeUrl({ origin: origin(shop), clientId: options.clientId, scopes: REQUIRED_SCOPES, redirectUri: params.redirectUri, state: params.state }));
    },
    async completeAuth(request, ctx) {
      const shop = ctx.storeDomain.toLowerCase();
      const credentials = await exchangeCallback({
        fetchImpl,
        origin: origin(shop),
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        callbackUrl: new URL(request.url),
        expectedShop: shop,
        requiredScopes: REQUIRED_SCOPES,
        now: Date.now(),
      });
      if (!credentials.ok) return credentials;
      return Ok({ credentials: { ...credentials.value }, storeDomain: shop });
    },
    async liveCredentials(store, refresh) {
      const credentials = parseShopifyCredentials(store.credentials);
      if (!credentials) return Err(credentialsRequired);
      const refreshed = await refreshIfExpiring({ fetchImpl, origin: origin(store.storeDomain), clientId: options.clientId, clientSecret: options.clientSecret, credentials, now: Date.now(), ...(refresh?.force === true ? { force: true } : {}) });
      if (!refreshed.ok) return refreshed;
      return Ok(refreshed.value === null ? null : { ...refreshed.value });
    },
    async fetchStoreProfile(store): Promise<Result<ChannelStoreProfile, ChannelConnectorError>> {
      const shop = target(store);
      if (!shop) return Err(credentialsRequired);
      const profile = await shopifyGraphql(shop, STORE_PROFILE_QUERY, {}, storeProfileSchema);
      if (!profile.ok) return profile;
      const { name, currencyCode, myshopifyDomain, primaryDomain } = profile.value.shop;
      // Both hosts serve the shop's own storefront, and Shopify attests to both by answering this
      // query for the token the merchant granted: no separate proof of ownership is needed.
      return Ok({ name, currency: currencyCode, storefrontHosts: [...new Set([myshopifyDomain.toLowerCase(), primaryDomain.host.toLowerCase()])] });
    },
    async importCatalog(store, cursor) {
      const shop = target(store);
      if (!shop) return Err(credentialsRequired);
      return readCatalogPage(shop, cursor);
    },
    async fetchCatalogItems(store, externalIds) {
      const shop = target(store);
      if (!shop) return Err(credentialsRequired);
      return readCatalogItems(shop, externalIds);
    },
    /**
     * Stock per VARIANT (the id every connector call site matches on), from `inventoryQuantity`:
     * available summed over every location, so a store with a non-selling location overstates
     * sellable stock. A few ids (the order-time check) are one `nodes` read; a variant Shopify no
     * longer has is omitted, which the caller treats as unconfirmed. More or none walk every page.
     */
    async fetchInventory(store, ids) {
      const shop = target(store);
      if (!shop) return Err(credentialsRequired);
      if (ids !== undefined && ids.length <= 250) {
        if (ids.length === 0) return Ok([]);
        const read = await shopifyGraphql(shop, VARIANT_INVENTORY_QUERY, { ids: ids.map((id) => shopifyGid("ProductVariant", id)) }, variantInventorySchema);
        if (!read.ok) return read;
        return Ok(read.value.nodes.filter(isVariantLevel).map(level));
      }
      const wanted = ids === undefined ? undefined : new Set(ids);
      const levels: ChannelInventoryLevel[] = [];
      let cursor: string | null = null;
      do {
        const page: Result<{ levels: ChannelInventoryLevel[]; nextCursor: string | null }, ChannelConnectorError> = await inventoryPage(shop, cursor);
        if (!page.ok) return page;
        levels.push(...page.value.levels.filter((entry) => wanted === undefined || wanted.has(entry.externalId)));
        cursor = page.value.nextCursor;
      } while (cursor !== null);
      return Ok(levels);
    },
    async fetchInventoryPage(store, cursor) {
      const shop = target(store);
      if (!shop) return Err(credentialsRequired);
      return inventoryPage(shop, cursor);
    },
    /**
     * Creates the paid order in the store. The platform's order id rides as `sourceIdentifier`, and
     * an order already carrying it is answered instead of created again: a retry after a lost
     * response must not put a second paid order in front of the merchant.
     */
    async pushOrder(store, slice: ChannelOrderSlice) {
      const shop = target(store);
      if (!shop) return Err(credentialsRequired);
      const existing = await shopifyGraphql(shop, ORDER_BY_SOURCE_QUERY, { query: `source_identifier:${JSON.stringify(slice.orderId)}` }, orderBySourceSchema);
      if (!existing.ok) return existing;
      const already = existing.value.orders.nodes[0];
      if (already) return Ok({ remoteOrderId: already.legacyResourceId });
      const [firstName, ...rest] = slice.customer.name.trim().split(/\s+/);
      const address = slice.customer.shippingAddress;
      // Shopify takes a province as its CODE. A region the shopper typed as a name is kept for the
      // courier on the second address line rather than sent where Shopify would reject it.
      const provinceCode = address.region !== undefined && /^[A-Z0-9]{1,3}$/.test(address.region) ? address.region : undefined;
      const regionText = address.region !== undefined && provinceCode === undefined ? address.region : undefined;
      const address2 = [address.line2, regionText].filter((part) => part !== undefined && part !== "").join(", ");
      const shippingAddress = {
        firstName: address.firstName,
        lastName: address.lastName,
        address1: address.line1,
        ...(address2 ? { address2 } : {}),
        city: address.city,
        ...(provinceCode ? { provinceCode } : {}),
        ...(address.postalCode ? { zip: address.postalCode } : {}),
        countryCode: address.countryCode,
        ...(address.phone ? { phone: address.phone } : {}),
      };
      const created = await shopifyGraphql(shop, ORDER_CREATE_MUTATION, {
        order: {
          sourceName: SOURCE_NAME,
          sourceIdentifier: slice.orderId,
          currency: slice.currency,
          email: slice.customer.email,
          financialStatus: "PAID",
          customer: { toUpsert: { email: slice.customer.email, firstName: firstName ?? "", lastName: rest.join(" ") } },
          shippingAddress,
          lineItems: slice.lines.map((line) => ({
            variantId: shopifyGid("ProductVariant", line.externalVariantId),
            quantity: line.quantity,
            // Defaults to false in orderCreate, which shows the order as "Shipping not required"
            // although it carries the shopper's address. Every slice has one, so every line ships.
            requiresShipping: true,
            priceSet: money(line.unitPrice, slice.currency),
          })),
          transactions: [{ kind: "SALE", status: "SUCCESS", gateway: SOURCE_NAME, amountSet: money(slice.grandTotal, slice.currency) }],
        },
        options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false, sendFulfillmentReceipt: false },
      }, orderCreateSchema);
      if (!created.ok) return created;
      const { order, userErrors } = created.value.orderCreate;
      if (userErrors.length > 0 || !order) {
        return Err({ code: "SHOPIFY_ORDER_REJECTED", message: `Shopify refused the order: ${userErrors.map((error) => error.message).join("; ") || "no order returned"}.`, retriable: false });
      }
      return Ok({ remoteOrderId: order.legacyResourceId });
    },
    async fetchOrderStatus(store, remoteId) {
      const shop = target(store);
      if (!shop) return Err(credentialsRequired);
      const read = await shopifyGraphql(shop, ORDER_STATUS_QUERY, { id: `gid://shopify/Order/${remoteId}` }, orderStatusSchema);
      if (!read.ok) return read;
      if (!read.value.order) return Err({ code: "SHOPIFY_ORDER_NOT_FOUND", message: `Shopify has no order ${remoteId}.`, retriable: false });
      return Ok(orderStatus(read.value.order));
    },
    /**
     * Every Shopify delivery — catalogue, stock, orders, uninstall and the mandatory compliance topics —
     * arrives at ONE app-level address declared in `shopify.app.toml`, signed with the app's client
     * secret (Shopify has no per-store webhook secret). The shop is named by a header, and a delivery
     * is identified by `X-Shopify-Webhook-Id`: `X-Shopify-Event-Id` is shared by every delivery one
     * merchant action produces, so deduplicating on it would drop a second topic as a "duplicate".
     */
    async verifyAppWebhook(request) {
      const body = await request.text();
      if (!validBase64Hmac(options.clientSecret, body, request.headers.get("x-shopify-hmac-sha256"))) {
        return Err({ code: "INVALID_APP_WEBHOOK_SIGNATURE", message: "Invalid Shopify webhook signature.", retriable: false });
      }
      const topic = request.headers.get("x-shopify-topic");
      const shopDomain = request.headers.get("x-shopify-shop-domain")?.toLowerCase();
      const id = request.headers.get("x-shopify-webhook-id");
      if (!topic || !shopDomain || !id) return Err({ code: "INVALID_APP_WEBHOOK", message: "Shopify webhook headers are incomplete.", retriable: false });
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return Err({ code: "INVALID_APP_WEBHOOK", message: "Shopify webhook body must be valid JSON.", retriable: false });
      }
      return Ok({ id, topic, shopDomain, data });
    },
    async refundExecute() {
      return Err({ code: "NOT_IMPLEMENTED", message: "Refunds are issued by the platform, not executed in the Shopify store." });
    },
  });

  async function inventoryPage(shop: ShopifyGraphqlTarget, cursor: string | null): Promise<Result<{ levels: ChannelInventoryLevel[]; nextCursor: string | null }, ChannelConnectorError>> {
    const page = await shopifyGraphql(shop, INVENTORY_QUERY, { after: cursor }, inventoryPageSchema);
    if (!page.ok) return page;
    const { pageInfo, nodes } = page.value.productVariants;
    if (pageInfo.hasNextPage && (!pageInfo.endCursor || pageInfo.endCursor === cursor)) {
      return Err({ code: "SHOPIFY_PAGINATION_STUCK", message: "Shopify answered an inventory page that does not advance.", retriable: false });
    }
    return Ok({ levels: nodes.map(level), nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null });
  }
}
