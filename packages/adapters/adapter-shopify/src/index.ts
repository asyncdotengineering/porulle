import { defineChannelConnector, Err, Ok } from "@porulle/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelCatalogPage,
  ChannelCatalogPrice,
  ChannelConnector,
  ChannelConnectorError,
  ChannelInventoryLevel,
  ChannelPushCatalogItem,
  ChannelPushCatalogResult,
  ChannelStore,
  ChannelOrderSlice,
  ChannelOrderStatus,
  Result,
} from "@porulle/core";
import {
  pushCatalog as executePushCatalog,
} from "./push-catalog.js";

export {
  PORULLE_METAFIELD_NAMESPACE,
  PUSH_CATALOG_SCOPE,
  SHOPIFY_NATIVE_PRODUCT_FIELDS,
  SHOPIFY_NATIVE_VARIANT_FIELDS,
  shopifyGrantedScopes,
  shopifyPushCatalogEnabled,
  shopifyWriteProductsScopeMissingError,
} from "./push-catalog.js";

export interface ShopifyConnectorOptions {
  fetchImpl?: typeof fetch;
  apiVersion?: string;
  clientId?: string;
  clientSecret?: string;
  appUrl?: string;
  scopes?: string[];
}

export const REQUIRED_SCOPES = [
  "read_products",
  "read_inventory",
  "read_orders",
  "write_orders",
  "read_fulfillments",
  "write_products",
] as const;

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle?: string;
  body_html?: string;
  vendor?: string | null;
  product_type?: string | null;
  tags?: string | null;
  status?: string | null;
  images?: Array<{
    id: number | string;
    src: string;
    alt?: string | null;
    position?: number | null;
    variant_ids?: Array<number | string> | null;
  }>;
  options?: Array<{
    name: string;
    position?: number | null;
    values?: string[];
  }>;
  variants?: Array<{
    id: number | string;
    sku?: string | null;
    barcode?: string | null;
    price?: string | null;
    compare_at_price?: string | null;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
  }>;
};

const zeroDecimalCurrencies = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toUpperCase();
}

function parseMoney(value: string | null | undefined, currency: string): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const exponent = zeroDecimalCurrencies.has(currency) ? 0 : 2;
  return Math.round(parsed * (10 ** exponent));
}

function pricesForVariant(
  variant: NonNullable<ShopifyProduct["variants"]>[number],
  currency: string | undefined,
): ChannelCatalogPrice[] | undefined {
  if (!currency) return undefined;
  const amount = parseMoney(variant.price, currency);
  if (amount === undefined) return undefined;
  const compareAtAmount = parseMoney(variant.compare_at_price, currency);
  return [{
    currency,
    amount,
    ...(compareAtAmount !== undefined && compareAtAmount !== amount ? { compareAtAmount } : {}),
  }];
}

function catalogStatus(value: string | null | undefined): "draft" | "active" | "archived" | undefined {
  return value === "draft" || value === "active" || value === "archived" ? value : undefined;
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function fetchShopCurrency(fetchImpl: typeof fetch, url: string, accessToken: string): Promise<string | undefined> {
  const result = await request<{ shop?: { currency?: string | null } }>(fetchImpl, url, accessToken);
  return result.ok ? normalizeCurrency(result.value.data.shop?.currency) : undefined;
}

function apiBase(store: ChannelStore, version: string): string {
  return `https://${store.storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/admin/api/${version}`;
}

function shopifyOAuthStartUrl(appUrl: string, storeDomain: string): string | undefined {
  try {
    const url = new URL("/api/channels/oauth/shopify/start", appUrl);
    url.searchParams.set("shop", storeDomain);
    return url.toString();
  } catch {
    return undefined;
  }
}

async function request<T>(fetchImpl: typeof fetch, url: string, accessToken: string, init?: RequestInit): Promise<Result<{ data: T; response: Response }>> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}), "x-shopify-access-token": accessToken },
    });
    if (!response.ok) return Err({ code: "SHOPIFY_API_FAILED", message: `Shopify API request failed (${response.status}) for ${url}.`, retriable: response.status >= 500 });
    return Ok({ data: await response.json() as T, response });
  } catch (error) {
    return Err({ code: "SHOPIFY_API_FAILED", message: error instanceof Error ? error.message : "Shopify API request failed.", retriable: true });
  }
}

function shopifyStatus(order: { financial_status?: string | null; fulfillment_status?: string | null; cancelled_at?: string | null }): ChannelOrderStatus {
  if (order.cancelled_at) return { status: "cancelled" };
  if (order.fulfillment_status === "fulfilled") return { status: "fulfilled" };
  if (order.financial_status === "paid" || order.financial_status === "partially_paid") return { status: "confirmed" };
  if (order.financial_status === "refunded" || order.financial_status === "voided") return { status: "failed" };
  return { status: "pending" };
}

function credentials(store: ChannelStore): string | undefined {
  const accessToken = store.credentials.accessToken;
  return typeof accessToken === "string" && accessToken.length > 0 ? accessToken : undefined;
}

function validBase64Hmac(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validShopDomain(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/i.test(value);
}

function oauthHmacMessage(searchParams: URLSearchParams): string {
  return [...searchParams.entries()]
    .filter(([key]) => key !== "hmac")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function validOAuthHmac(searchParams: URLSearchParams, secret: string): boolean {
  const provided = searchParams.get("hmac");
  if (!provided || !/^[a-f0-9]+$/i.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(oauthHmacMessage(searchParams)).digest();
  const actual = Buffer.from(provided, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function oauthError(code: string, message: string): Result<never, ChannelConnectorError> {
  return Err({ code, message, retriable: false });
}

export function shopifyReauthorizeUrl(
  options: ShopifyConnectorOptions,
  params: {
    storeDomain: string;
    state: string;
    redirectUri: string;
    callbackUri: string;
    scopes?: string[];
  },
): Result<string, ChannelConnectorError> {
  return shopifyConnector(options).buildAuthUrl!({
    ...params,
    scopes: params.scopes ?? [],
  });
}

export function shopifyConnector(options: ShopifyConnectorOptions = {}): ChannelConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const version = options.apiVersion ?? "2024-10";
  const currencyCache = new Map<string, Promise<string | undefined>>();
  return defineChannelConnector({
    providerId: "shopify",
    capabilities: { importCatalog: true, importInventory: true, pushOrder: true, pushCatalog: true, receiveWebhooks: true },
    buildAuthUrl(params) {
      if (!options.clientId || !options.clientSecret || !options.appUrl) {
        return oauthError("SHOPIFY_OAUTH_NOT_CONFIGURED", "Shopify OAuth requires clientId, clientSecret, and appUrl.");
      }
      const shopDomain = params.storeDomain.toLowerCase();
      if (!validShopDomain(shopDomain)) return oauthError("SHOPIFY_INVALID_STORE_DOMAIN", "Shopify storeDomain must be a *.myshopify.com domain.");
      const scopes = [...new Set([...REQUIRED_SCOPES, ...(options.scopes ?? []), ...params.scopes])];
      const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("redirect_uri", params.redirectUri);
      url.searchParams.set("state", params.state);
      return Ok(url.toString());
    },
    async completeAuth(request, ctx) {
      if (!options.clientId || !options.clientSecret || !options.appUrl) {
        return oauthError("SHOPIFY_OAUTH_NOT_CONFIGURED", "Shopify OAuth requires clientId, clientSecret, and appUrl.");
      }
      const url = new URL(request.url);
      const shopDomain = ctx.storeDomain.toLowerCase();
      const callbackShop = url.searchParams.get("shop")?.toLowerCase();
      if (!validShopDomain(shopDomain) || callbackShop !== shopDomain) {
        return oauthError("SHOPIFY_INVALID_STORE_DOMAIN", "Shopify storeDomain must be a *.myshopify.com domain.");
      }
      if (!validOAuthHmac(url.searchParams, options.clientSecret)) {
        return oauthError("SHOPIFY_INVALID_OAUTH_HMAC", "Shopify OAuth callback HMAC is invalid.");
      }
      const timestamp = Number(url.searchParams.get("timestamp"));
      if (!Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) {
        return oauthError("SHOPIFY_STALE_OAUTH_CALLBACK", "Shopify OAuth callback timestamp is stale.");
      }
      const code = url.searchParams.get("code");
      if (!code) return oauthError("SHOPIFY_OAUTH_CODE_REQUIRED", "Shopify OAuth callback code is required.");
      try {
        const response = await fetchImpl(`https://${shopDomain}/admin/oauth/access_token`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ client_id: options.clientId, client_secret: options.clientSecret, code }),
        });
        if (!response.ok) return oauthError("SHOPIFY_TOKEN_EXCHANGE_FAILED", `Shopify token exchange failed (${response.status}).`);
        const body = await response.json() as { access_token?: unknown; scope?: unknown };
        if (typeof body.access_token !== "string" || !body.access_token) return oauthError("SHOPIFY_TOKEN_INVALID", "Shopify token exchange did not return an access token.");
        const grantedScopes = typeof body.scope === "string"
          ? body.scope.split(",").map((scope) => scope.trim()).filter(Boolean)
          : [];
        return Ok({ credentials: { accessToken: body.access_token, grantedScopes }, storeDomain: shopDomain });
      } catch (error) {
        return Err({ code: "SHOPIFY_TOKEN_EXCHANGE_FAILED", message: error instanceof Error ? error.message : "Shopify token exchange failed.", retriable: true });
      }
    },
    async importCatalog(store, cursor): Promise<Result<ChannelCatalogPage>> {
      const token = credentials(store);
      if (!token) return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "Shopify accessToken is required." });
      const currencyUrl = `${apiBase(store, version)}/shop.json`;
      const currencyKey = apiBase(store, version);
      let currencyPromise = currencyCache.get(currencyKey);
      if (!currencyPromise) {
        currencyPromise = fetchShopCurrency(fetchImpl, currencyUrl, token);
        currencyCache.set(currencyKey, currencyPromise);
      }
      const currency = await currencyPromise;
      const url = cursor ?? `${apiBase(store, version)}/products.json?limit=250`;
      const result = await request<{ products: ShopifyProduct[] }>(fetchImpl, url, token);
      if (!result.ok) return result;
      const link = result.value.response.headers.get("link") ?? "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
      return Ok({
        items: result.value.data.products.map((product) => {
          const options = product.options?.map((option, index) => ({
            name: option.name,
            displayName: option.name,
            ...(option.position != null ? { sortOrder: option.position } : { sortOrder: index }),
            values: (option.values ?? []).map((value, valueIndex) => ({ value, displayValue: value, sortOrder: valueIndex })),
          }));
          const variants = (product.variants ?? []).map((variant) => {
            const selectors = [variant.option1, variant.option2, variant.option3];
            const optionValues = Object.fromEntries((product.options ?? []).slice(0, 3).flatMap((option, index) => {
              const value = selectors[index];
              return value != null && value !== "" ? [[option.name, value] as const] : [];
            }));
            const prices = pricesForVariant(variant, currency);
            return {
              externalId: String(variant.id),
              ...(variant.sku ? { sku: variant.sku } : {}),
              ...(variant.barcode ? { barcode: variant.barcode } : {}),
              ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
              ...(prices ? { prices } : {}),
            };
          });
          const category = product.product_type ? slugify(product.product_type) : "";
          const status = catalogStatus(product.status);
          return {
            externalId: String(product.id),
            slug: product.handle ?? String(product.id),
            title: product.title,
            attributes: [{ locale: "en", title: product.title, ...(product.body_html != null ? { description: product.body_html } : {}) }],
            variants,
            ...(product.images ? {
              images: product.images.map((image, index) => ({
                externalId: String(image.id),
                url: image.src,
                ...(image.alt != null ? { alt: image.alt } : {}),
                role: index === 0 ? "primary" as const : "gallery" as const,
                ...(image.position != null ? { sortOrder: image.position } : {}),
                ...(image.variant_ids != null ? { variantExternalIds: image.variant_ids.map(String) } : {}),
              })),
            } : {}),
            ...(options ? { options } : {}),
            ...(product.tags != null ? { tags: product.tags.split(",").map((tag) => tag.trim()).filter(Boolean) } : {}),
            ...(product.vendor ? { brand: product.vendor } : {}),
            ...(category ? { categories: [category] } : {}),
            ...(status ? { status } : {}),
          };
        }),
        nextCursor: next,
      });
    },
    async fetchInventory(store, ids): Promise<Result<ChannelInventoryLevel[]>> {
      const token = credentials(store);
      if (!token) return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "Shopify accessToken is required." });
      const params = new URLSearchParams({ limit: "250" });
      if (ids?.length) params.set("inventory_item_ids", ids.join(","));
      const result = await request<{ inventory_levels: Array<{ inventory_item_id: number | string; available: number | null }> }>(fetchImpl, `${apiBase(store, version)}/inventory_levels.json?${params}`, token);
      if (!result.ok) return result;
      return Ok(result.value.data.inventory_levels.map((level) => ({ externalId: String(level.inventory_item_id), available: level.available ?? 0 })));
    },
    async pushCatalog(store: ChannelStore, items: ChannelPushCatalogItem[], opts?: { dryRun?: boolean }): Promise<Result<ChannelPushCatalogResult, ChannelConnectorError>> {
      const oauthStartUrl = options.appUrl ? shopifyOAuthStartUrl(options.appUrl, store.storeDomain) : undefined;
      return executePushCatalog({
        fetchImpl,
        apiBase: (target) => apiBase(target, version),
        credentials,
      }, store, items, {
        ...(opts?.dryRun === true ? { dryRun: true } : {}),
        ...(oauthStartUrl ? { reauthorizeUrl: oauthStartUrl } : {}),
      });
    },
    async pushOrder(store, slice: ChannelOrderSlice) {
      const token = credentials(store);
      if (!token) return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "Shopify accessToken is required.", retriable: false });
      const [firstName, ...lastParts] = slice.customer.name.trim().split(/\s+/);
      const result = await request<{ order: { id: number | string; admin_graphql_api_id?: string } }>(fetchImpl, `${apiBase(store, version)}/orders.json`, token, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `porulle:${slice.orderId}` },
        body: JSON.stringify({ order: {
          financial_status: "paid",
          line_items: slice.lines.map((line) => ({ variant_id: line.externalVariantId, quantity: line.quantity, price: line.unitPrice / 100 })),
          customer: { email: slice.customer.email, first_name: firstName ?? "", last_name: lastParts.join(" ") },
          shipping_address: slice.customer.shippingAddress,
          transactions: [{ kind: "sale", status: "success", amount: slice.grandTotal / 100 }],
        } }),
      });
      if (!result.ok) return result;
      const id = String(result.value.data.order.id);
      return Ok({ remoteOrderId: id, remoteUrl: `${apiBase(store, version)}/orders/${id}.json` });
    },
    async fetchOrderStatus(store, remoteId) {
      const token = credentials(store);
      if (!token) return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "Shopify accessToken is required.", retriable: false });
      const result = await request<{ order: { financial_status?: string | null; fulfillment_status?: string | null; cancelled_at?: string | null } }>(fetchImpl, `${apiBase(store, version)}/orders/${encodeURIComponent(remoteId)}.json`, token);
      return result.ok ? Ok(shopifyStatus(result.value.data.order)) : result;
    },
    async verifyWebhook(_store, request) {
      const body = await request.text();
      // Shopify signs every webhook for an app with the app CLIENT SECRET — there is no
      // per-store/per-subscription secret (unlike WooCommerce). Verify against clientSecret.
      if (!options.clientSecret) {
        return Err({ code: "SHOPIFY_CLIENT_SECRET_MISSING", message: "Shopify clientSecret is required to verify webhooks." });
      }
      if (!validBase64Hmac(options.clientSecret, body, request.headers.get("x-shopify-hmac-sha256"))) {
        return Err({ code: "INVALID_WEBHOOK_SIGNATURE", message: "Invalid Shopify webhook signature." });
      }
      try {
        const data = JSON.parse(body) as unknown;
        const id = request.headers.get("x-shopify-event-id");
        const type = request.headers.get("x-shopify-topic");
        if (!id || !type) return Err({ code: "INVALID_WEBHOOK", message: "Shopify webhook headers are incomplete." });
        return Ok({ id, type, data });
      } catch {
        return Err({ code: "INVALID_WEBHOOK", message: "Shopify webhook body must be valid JSON." });
      }
    },
    async verifyAppWebhook(request) {
      if (!options.clientSecret) {
        return Err({ code: "SHOPIFY_CLIENT_SECRET_MISSING", message: "Shopify clientSecret is required to verify app webhooks.", retriable: false });
      }
      const body = await request.text();
      if (!validBase64Hmac(options.clientSecret, body, request.headers.get("x-shopify-hmac-sha256"))) {
        return Err({ code: "INVALID_APP_WEBHOOK_SIGNATURE", message: "Invalid Shopify app webhook signature.", retriable: false });
      }
      try {
        const data = JSON.parse(body) as unknown;
        const payload = data as Record<string, unknown>;
        const topic = request.headers.get("x-shopify-topic");
        const shopDomain = typeof payload.shop_domain === "string" ? payload.shop_domain : "";
        if (!topic) return Err({ code: "INVALID_APP_WEBHOOK", message: "Shopify app webhook topic header is missing.", retriable: false });
        return Ok({ topic, shopDomain, data });
      } catch {
        return Err({ code: "INVALID_APP_WEBHOOK", message: "Shopify app webhook body must be valid JSON.", retriable: false });
      }
    },
    async registerWebhooks(store: ChannelStore, topics: string[], callbackUrl: string) {
      const token = credentials(store);
      if (!token) return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "Shopify accessToken is required." });
      for (const topic of topics) {
        const result = await request<{ webhook: unknown }>(fetchImpl, `${apiBase(store, version)}/webhooks.json`, token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ webhook: { topic, address: callbackUrl, format: "json" } }),
        });
        if (!result.ok) return result;
      }
      return Ok({ registered: topics.length });
    },
    async refundExecute() { return Err({ code: "NOT_IMPLEMENTED", message: "Shopify refund execution is not implemented in this slice." }); },
  });
}
