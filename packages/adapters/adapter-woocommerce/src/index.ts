import { defineChannelConnector, Err, Ok } from "@porulle/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelCatalogPage, ChannelCatalogPrice, ChannelConnector, ChannelConnectorError, ChannelInventoryLevel, ChannelStore, ChannelOrderSlice, ChannelOrderStatus, Result } from "@porulle/core";

export interface WooConnectorOptions { fetchImpl?: typeof fetch }

type WooProduct = {
  id: number | string;
  name: string;
  slug?: string;
  description?: string | null;
  status?: string | null;
  images?: Array<{ id: number | string; src: string; alt?: string | null; position?: number | null }>;
  attributes?: Array<{ name: string; variation?: boolean | null; position?: number | null; options?: string[] }>;
  tags?: Array<{ slug?: string | null }>;
  categories?: Array<{ slug?: string | null }>;
  variations?: Array<number | string | {
    id: number | string;
    sku?: string | null;
    price?: string | null;
    attributes?: Array<{ name: string; option?: string | null }>;
  }>;
  stock_quantity?: number | null;
};

type WooProductVariation = {
  id: number | string;
  sku?: string | null;
  price?: string | null;
  attributes?: Array<{ name: string; option?: string | null }>;
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

function buildWooUrl(base: string, path: string, key: string, secret: string, page: number, cursor?: string): string {
  const url = new URL(path, base.replace(/\/$/, "/"));
  url.searchParams.set("consumer_key", key);
  url.searchParams.set("consumer_secret", secret);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  if (cursor) url.searchParams.set("modified_after", cursor);
  return url.toString();
}

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

function pricesForVariation(variation: WooProductVariation, currency: string | undefined): ChannelCatalogPrice[] | undefined {
  if (!currency) return undefined;
  const amount = parseMoney(variation.price, currency);
  return amount === undefined ? undefined : [{ currency, amount }];
}

function catalogStatus(value: string | null | undefined): "draft" | "active" | undefined {
  if (value === "publish") return "active";
  if (value === "draft" || value === "private") return "draft";
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function settingCurrency(data: unknown): string | undefined {
  if (Array.isArray(data)) {
    for (const entry of data) {
      const setting = asRecord(entry);
      if (setting?.id === "woocommerce_currency") return normalizeCurrency(setting.value);
    }
  }
  const object = asRecord(data);
  if (!object) return undefined;
  const direct = normalizeCurrency(object.woocommerce_currency);
  if (direct) return direct;
  const systemStatus = asRecord(object.system_status);
  return normalizeCurrency(systemStatus?.woocommerce_currency);
}

async function fetchWooCurrency(fetchImpl: typeof fetch, url: string): Promise<string | undefined> {
  const result = await request<unknown>(fetchImpl, url);
  return result.ok ? settingCurrency(result.value.data) : undefined;
}

async function fetchProductVariations(
  fetchImpl: typeof fetch,
  storeDomain: string,
  auth: { key: string; secret: string },
  productId: string,
  modifiedAfter: string | undefined,
): Promise<Result<WooProductVariation[]>> {
  const variations: WooProductVariation[] = [];
  let page = 1;
  while (true) {
    const result = await request<WooProductVariation[]>(fetchImpl, buildWooUrl(storeDomain, `/wp-json/wc/v3/products/${encodeURIComponent(productId)}/variations`, auth.key, auth.secret, page, modifiedAfter));
    if (!result.ok) return result;
    variations.push(...result.value.data);
    const totalPages = Number.parseInt(result.value.response.headers.get("x-wp-totalpages") ?? "1", 10);
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
    page += 1;
  }
  return Ok(variations);
}

function variationFromReference(reference: NonNullable<WooProduct["variations"]>[number]): WooProductVariation {
  return typeof reference === "object" && reference !== null ? reference : { id: reference };
}

function mergeProductVariations(
  references: NonNullable<WooProduct["variations"]>,
  details: WooProductVariation[],
): WooProductVariation[] {
  const detailById = new Map(details.map((variation) => [String(variation.id), variation]));
  const referencedIds = new Set<string>();
  const merged = references.map((reference) => {
    const fallback = variationFromReference(reference);
    const id = String(fallback.id);
    referencedIds.add(id);
    return detailById.get(id) ?? fallback;
  });
  return [...merged, ...details.filter((variation) => !referencedIds.has(String(variation.id)))];
}

async function request<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Result<{ data: T; response: Response }>> {
  try {
    const response = await fetchImpl(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
    if (!response.ok) return Err({ code: "WOO_API_FAILED", message: `WooCommerce request failed (${response.status}) for ${url}.`, retriable: response.status >= 500 });
    return Ok({ data: await response.json() as T, response });
  } catch (error) {
    return Err({ code: "WOO_API_FAILED", message: error instanceof Error ? error.message : "WooCommerce request failed.", retriable: true });
  }
}

function wooStatus(status: string | undefined): ChannelOrderStatus {
  if (status === "completed") return { status: "fulfilled" };
  if (status === "processing" || status === "on-hold") return { status: "confirmed" };
  if (status === "cancelled") return { status: "cancelled" };
  if (status === "failed" || status === "refunded") return { status: "failed" };
  return { status: "pending" };
}

function credentials(store: ChannelStore): { key: string; secret: string } | undefined {
  const key = store.credentials.consumerKey;
  const secret = store.credentials.consumerSecret;
  return typeof key === "string" && typeof secret === "string" && key && secret ? { key, secret } : undefined;
}

function validBase64Hmac(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function oauthError(code: string, message: string): Result<never, ChannelConnectorError> {
  return Err({ code, message, retriable: false });
}

function storeUrl(domain: string): URL | undefined {
  try {
    const url = new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function wooConnector(options: WooConnectorOptions = {}): ChannelConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const currencyCache = new Map<string, Promise<string | undefined>>();
  return defineChannelConnector({
    providerId: "woocommerce",
    capabilities: { importCatalog: true, importInventory: true, pushOrder: true, receiveWebhooks: true },
    buildAuthUrl(params) {
      const store = storeUrl(params.storeDomain);
      if (!store) return oauthError("WOO_INVALID_STORE_DOMAIN", "WooCommerce storeDomain must be an HTTP(S) URL.");
      let callback: URL;
      try {
        callback = new URL(params.callbackUri);
      } catch {
        return oauthError("WOO_INVALID_CALLBACK_URL", "WooCommerce callbackUri must be an HTTPS URL.");
      }
      if (callback.protocol !== "https:") return oauthError("WOO_INVALID_CALLBACK_URL", "WooCommerce callbackUri must be an HTTPS URL.");
      callback.searchParams.set("state", params.state);
      const returnUrl = new URL(params.callbackUri);
      returnUrl.searchParams.set("state", params.state);
      returnUrl.searchParams.set("return", "1");
      const url = new URL("/wc-auth/v1/authorize", store.origin);
      url.searchParams.set("app_name", "Porulle");
      url.searchParams.set("scope", "read_write");
      url.searchParams.set("user_id", "porulle");
      url.searchParams.set("return_url", returnUrl.toString());
      url.searchParams.set("callback_url", callback.toString());
      return Ok(url.toString());
    },
    async completeAuth(request, ctx) {
      if (request.method !== "POST") return oauthError("WOO_AUTH_METHOD_REQUIRED", "WooCommerce auth credentials must be posted.");
      const store = storeUrl(ctx.storeDomain);
      if (!store) return oauthError("WOO_INVALID_STORE_DOMAIN", "WooCommerce storeDomain must be an HTTP(S) URL.");
      try {
        const body = await request.json() as Record<string, unknown>;
        const consumerKey = body.consumer_key;
        const consumerSecret = body.consumer_secret;
        if (typeof consumerKey !== "string" || !consumerKey || typeof consumerSecret !== "string" || !consumerSecret) {
          return oauthError("WOO_AUTH_CREDENTIALS_INVALID", "WooCommerce auth response must include consumer_key and consumer_secret.");
        }
        return Ok({ credentials: { consumerKey, consumerSecret }, storeDomain: ctx.storeDomain });
      } catch {
        return oauthError("WOO_AUTH_RESPONSE_INVALID", "WooCommerce auth response must be valid JSON.");
      }
    },
    async importCatalog(store, cursor): Promise<Result<ChannelCatalogPage>> {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required." });
      const [pagePart, ...afterParts] = cursor?.split("|") ?? [];
      const isPage = pagePart === undefined || /^\d+$/.test(pagePart);
      const parsedPage = isPage && pagePart ? Number.parseInt(pagePart, 10) : 1;
      const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      const modifiedAfter = afterParts.length > 0 ? afterParts.join("|") : (!isPage ? cursor : undefined);
      const currencyKey = store.storeDomain.replace(/\/$/, "");
      let currencyPromise = currencyCache.get(currencyKey);
      if (!currencyPromise) {
        currencyPromise = fetchWooCurrency(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/settings/general", auth.key, auth.secret, 1));
        currencyCache.set(currencyKey, currencyPromise);
      }
      const currency = await currencyPromise;
      const result = await request<WooProduct[]>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/products", auth.key, auth.secret, page, modifiedAfter));
      if (!result.ok) return result;
      const totalPages = Number.parseInt(result.value.response.headers.get("x-wp-totalpages") ?? "1", 10);
      const nextCursor = page < totalPages ? (modifiedAfter ? `${page + 1}|${modifiedAfter}` : String(page + 1)) : null;
      const items = [];
      for (const product of result.value.data) {
        const references = product.variations ?? [];
        const details = references.length > 0
          ? await fetchProductVariations(fetchImpl, store.storeDomain, auth, String(product.id), modifiedAfter)
          : Ok<WooProductVariation[]>([]);
        if (!details.ok) return details;
        const variants = mergeProductVariations(references, details.value).map((variant) => {
          const optionValues = Object.fromEntries((variant.attributes ?? []).flatMap((attribute) => (
            attribute.option != null && attribute.option !== "" ? [[attribute.name, attribute.option] as const] : []
          )));
          const prices = pricesForVariation(variant, currency);
          return {
            externalId: String(variant.id),
            ...(variant.sku ? { sku: variant.sku } : {}),
            ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
            ...(prices ? { prices } : {}),
          };
        });
        const options = product.attributes?.filter((attribute) => attribute.variation === true).map((attribute, index) => ({
          name: attribute.name,
          displayName: attribute.name,
          ...(attribute.position != null ? { sortOrder: attribute.position } : { sortOrder: index }),
          values: (attribute.options ?? []).map((value, valueIndex) => ({ value, displayValue: value, sortOrder: valueIndex })),
        }));
        const status = catalogStatus(product.status);
        items.push({
          externalId: String(product.id),
          slug: product.slug ?? String(product.id),
          title: product.name,
          attributes: [{ locale: "en", title: product.name, ...(product.description != null ? { description: product.description } : {}) }],
          variants,
          ...(product.images ? {
            images: product.images.map((image, index) => ({
              externalId: String(image.id),
              url: image.src,
              ...(image.alt != null ? { alt: image.alt } : {}),
              role: index === 0 ? "primary" as const : "gallery" as const,
              ...(image.position != null ? { sortOrder: image.position } : {}),
            })),
          } : {}),
          ...(options ? { options } : {}),
          ...(product.tags ? { tags: product.tags.flatMap((tag) => tag.slug ? [tag.slug] : []) } : {}),
          ...(product.categories ? { categories: product.categories.flatMap((category) => category.slug ? [category.slug] : []) } : {}),
          ...(status ? { status } : {}),
        });
      }
      return Ok({ items, nextCursor });
    },
    async fetchInventory(store, ids): Promise<Result<ChannelInventoryLevel[]>> {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required." });
      const page = await request<WooProduct[]>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/products", auth.key, auth.secret, 1));
      if (!page.ok) return page;
      const requested = ids ? new Set(ids) : undefined;
      return Ok(page.value.data.filter((product) => !requested || requested.has(String(product.id))).map((product) => ({ externalId: String(product.id), available: product.stock_quantity ?? 0 })));
    },
    async pushOrder(store, slice: ChannelOrderSlice) {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required.", retriable: false });
      const url = buildWooUrl(store.storeDomain, "/wp-json/wc/v3/orders", auth.key, auth.secret, 1);
      const [firstName, ...lastParts] = slice.customer.name.trim().split(/\s+/);
      const address = slice.customer.shippingAddress;
      const billing = { first_name: firstName ?? "", last_name: lastParts.join(" "), email: slice.customer.email, ...address };
      const result = await request<{ id: number | string }>(fetchImpl, url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `porulle:${slice.orderId}` },
        body: JSON.stringify({ set_paid: true, line_items: slice.lines.map((line) => ({ variation_id: line.externalVariantId, quantity: line.quantity, total: line.totalPrice / 100 })), billing, shipping: address }),
      });
      if (!result.ok) return result;
      const id = String(result.value.data.id);
      return Ok({ remoteOrderId: id, remoteUrl: `${store.storeDomain.replace(/\/$/, "")}/wp-admin/post.php?post=${id}&action=edit` });
    },
    async fetchOrderStatus(store, remoteId) {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required.", retriable: false });
      const result = await request<{ status?: string }>(fetchImpl, buildWooUrl(store.storeDomain, `/wp-json/wc/v3/orders/${encodeURIComponent(remoteId)}`, auth.key, auth.secret, 1));
      return result.ok ? Ok(wooStatus(result.value.data.status)) : result;
    },
    async verifyWebhook(store, request) {
      const body = await request.text();
      if (!validBase64Hmac(store.webhookSecret ?? "", body, request.headers.get("x-wc-webhook-signature"))) {
        return Err({ code: "INVALID_WEBHOOK_SIGNATURE", message: "Invalid WooCommerce webhook signature." });
      }
      try {
        const data = JSON.parse(body) as unknown;
        const id = request.headers.get("x-wc-webhook-id");
        const type = request.headers.get("x-wc-webhook-topic");
        if (!id || !type) return Err({ code: "INVALID_WEBHOOK", message: "WooCommerce webhook headers are incomplete." });
        return Ok({ id, type, data });
      } catch {
        return Err({ code: "INVALID_WEBHOOK", message: "WooCommerce webhook body must be valid JSON." });
      }
    },
    async registerWebhooks(store: ChannelStore, topics: string[], callbackUrl: string) {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required." });
      for (const topic of topics) {
        const result = await request<{ id: number | string }>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/webhooks", auth.key, auth.secret, 1), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `Porulle ${topic}`, topic, delivery_url: callbackUrl, secret: store.webhookSecret }),
        });
        if (!result.ok) return result;
      }
      return Ok({ registered: topics.length });
    },
    async refundExecute() { return Err({ code: "NOT_IMPLEMENTED", message: "WooCommerce refund execution is not implemented in this slice." }); },
  });
}
