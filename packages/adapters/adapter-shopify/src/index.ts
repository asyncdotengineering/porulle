import { defineChannelConnector, Err, Ok } from "@porulle/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelCatalogPage,
  ChannelConnector,
  ChannelInventoryLevel,
  ChannelStore,
  ChannelOrderSlice,
  ChannelOrderStatus,
  Result,
} from "@porulle/core";

export interface ShopifyConnectorOptions {
  fetchImpl?: typeof fetch;
  apiVersion?: string;
}

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle?: string;
  body_html?: string;
  variants?: Array<{ id: number | string; sku?: string | null; barcode?: string | null; price?: string | null }>;
};

function parseMoney(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function apiBase(store: ChannelStore, version: string): string {
  return `https://${store.storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/admin/api/${version}`;
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

export function shopifyConnector(options: ShopifyConnectorOptions = {}): ChannelConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const version = options.apiVersion ?? "2024-10";
  return defineChannelConnector({
    providerId: "shopify",
    capabilities: { importCatalog: true, importInventory: true, pushOrder: true, receiveWebhooks: true },
    async importCatalog(store, cursor): Promise<Result<ChannelCatalogPage>> {
      const token = credentials(store);
      if (!token) return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "Shopify accessToken is required." });
      const url = cursor ?? `${apiBase(store, version)}/products.json?limit=250`;
      const result = await request<{ products: ShopifyProduct[] }>(fetchImpl, url, token);
      if (!result.ok) return result;
      const link = result.value.response.headers.get("link") ?? "";
      const next = link.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
      return Ok({
        items: result.value.data.products.map((product) => ({
          externalId: String(product.id),
          slug: product.handle ?? String(product.id),
          title: product.title,
          ...(product.body_html ? { description: product.body_html } : {}),
          variants: (product.variants ?? []).map((variant) => ({
            externalId: String(variant.id),
            ...(variant.sku ? { sku: variant.sku } : {}),
            ...(variant.barcode ? { barcode: variant.barcode } : {}),
            metadata: { price: parseMoney(variant.price) },
          })),
        })),
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
    async verifyWebhook(store, request) {
      const body = await request.text();
      if (!validBase64Hmac(store.webhookSecret ?? "", body, request.headers.get("x-shopify-hmac-sha256"))) {
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
