import { defineChannelConnector, Err, Ok } from "@porulle/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelCatalogPage, ChannelConnector, ChannelInventoryLevel, ChannelStore, ChannelOrderSlice, ChannelOrderStatus, Result } from "@porulle/core";

export interface WooConnectorOptions { fetchImpl?: typeof fetch }

type WooProduct = {
  id: number | string;
  name: string;
  slug?: string;
  description?: string;
  variations?: Array<{ id: number | string; sku?: string | null; price?: string | null }>;
  stock_quantity?: number | null;
};

function buildWooUrl(base: string, path: string, key: string, secret: string, page: number, cursor?: string): string {
  const url = new URL(path, base.replace(/\/$/, "/"));
  url.searchParams.set("consumer_key", key);
  url.searchParams.set("consumer_secret", secret);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  if (cursor) url.searchParams.set("modified_after", cursor);
  return url.toString();
}

function parseMoney(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
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

export function wooConnector(options: WooConnectorOptions = {}): ChannelConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  return defineChannelConnector({
    providerId: "woocommerce",
    capabilities: { importCatalog: true, importInventory: true, pushOrder: true, receiveWebhooks: true },
    async importCatalog(store, cursor): Promise<Result<ChannelCatalogPage>> {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required." });
      const [pagePart, ...afterParts] = cursor?.split("|") ?? [];
      const isPage = pagePart === undefined || /^\d+$/.test(pagePart);
      const parsedPage = isPage && pagePart ? Number.parseInt(pagePart, 10) : 1;
      const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      const modifiedAfter = afterParts.length > 0 ? afterParts.join("|") : (!isPage ? cursor : undefined);
      const result = await request<WooProduct[]>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/products", auth.key, auth.secret, page, modifiedAfter));
      if (!result.ok) return result;
      const totalPages = Number.parseInt(result.value.response.headers.get("x-wp-totalpages") ?? "1", 10);
      const nextCursor = page < totalPages ? (modifiedAfter ? `${page + 1}|${modifiedAfter}` : String(page + 1)) : null;
      return Ok({ items: result.value.data.map((product) => ({
        externalId: String(product.id),
        slug: product.slug ?? String(product.id),
        title: product.name,
        ...(product.description ? { description: product.description } : {}),
        variants: (product.variations ?? []).map((variant) => ({
          externalId: String(variant.id),
          ...(variant.sku ? { sku: variant.sku } : {}),
          metadata: { price: parseMoney(variant.price) },
        })),
      })), nextCursor });
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
