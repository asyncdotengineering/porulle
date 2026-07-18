import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { shopifyConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "shopify", credentials: { accessToken: "token" }, storeDomain: "shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

describe("shopify connector", () => {
  it("paginates catalog, maps variants, and sends auth", async () => {
    const requests: string[] = [];
    const connector = shopifyConnector({ fetchImpl: async (input, init) => {
      requests.push(`${String(input)} ${init?.headers ? (init.headers as Record<string, string>)["x-shopify-access-token"] : ""}`);
      if (String(input).includes("page_info=next")) return new Response(JSON.stringify({ products: [{ id: 2, title: "Second", handle: "second", variants: [] }] }), { headers: { link: "" } });
      return new Response(JSON.stringify({ products: [{ id: 1, title: "First", handle: "first", variants: [{ id: 11, sku: "SKU", barcode: "BAR", price: "12.34" }] }] }), { headers: { link: '<https://shop.example/admin/api/2024-10/products.json?limit=250&page_info=next>; rel="next"' } });
    } });
    const first = await connector.importCatalog(store);
    expect(first.ok && first.value.items[0]).toMatchObject({ externalId: "1", slug: "first", variants: [{ externalId: "11", sku: "SKU", barcode: "BAR", metadata: { price: 1234 } }] });
    expect(first.ok && first.value.nextCursor).toContain("page_info=next");
    const second = await connector.importCatalog(store, first.ok ? first.value.nextCursor ?? undefined : undefined);
    expect(second.ok && second.value.items[0]?.externalId).toBe("2");
    expect(requests.every((request) => request.endsWith(" token"))).toBe(true);
  });

  it("maps inventory and returns API errors", async () => {
    const connector = shopifyConnector({ fetchImpl: async () => new Response(JSON.stringify({ inventory_levels: [{ inventory_item_id: 11, available: 4 }] })) });
    expect(await connector.fetchInventory(store, ["11"])).toEqual({ ok: true, value: [{ externalId: "11", available: 4 }] });
    const failed = shopifyConnector({ fetchImpl: async () => new Response("", { status: 500 }) });
    const result = await failed.importCatalog(store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SHOPIFY_API_FAILED");
  });

  it("injects a paid order with platform amounts and maps remote status", async () => {
    let body = "";
    const connector = shopifyConnector({ fetchImpl: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ order: { id: 42 } }));
    } });
    const pushed = await connector.pushOrder(store, {
      orderId: "order-1",
      currency: "USD",
      grandTotal: 2500,
      lines: [{ externalVariantId: "11", title: "Lamp", quantity: 2, unitPrice: 1250, totalPrice: 2500 }],
      customer: { name: "Priya Shopper", email: "priya@example.test", shippingAddress: { address1: "1 Main St", city: "Colombo", country: "LK" } },
    });
    expect(pushed).toEqual({ ok: true, value: { remoteOrderId: "42", remoteUrl: expect.stringContaining("orders/42") } });
    expect(JSON.parse(body)).toMatchObject({ order: { financial_status: "paid", transactions: [{ kind: "sale", amount: 25 }], line_items: [{ variant_id: "11", price: 12.5 }], customer: { email: "priya@example.test" } } });

    const status = shopifyConnector({ fetchImpl: async () => new Response(JSON.stringify({ order: { financial_status: "paid", fulfillment_status: "fulfilled" } })) });
    expect(await status.fetchOrderStatus(store, "42")).toEqual({ ok: true, value: { status: "fulfilled" } });
    const failed = shopifyConnector({ fetchImpl: async () => new Response("", { status: 422 }) });
    const error = await failed.pushOrder(store, { orderId: "order-1", currency: "USD", grandTotal: 0, lines: [], customer: { name: "", email: "a@test", shippingAddress: {} } });
    expect(error.ok).toBe(false);
    if (!error.ok) expect(error.error.retriable).toBe(false);
  });

  it("verifies raw-body HMAC and registers webhook subscriptions", async () => {
    const body = JSON.stringify({ id: 1 });
    const signature = createHmac("sha256", store.webhookSecret).update(body).digest("base64");
    const connector = shopifyConnector({ fetchImpl: async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ webhook: { topic: "refunds/create", address: "/api/channels/webhooks/store-1", format: "json" } });
      return new Response(JSON.stringify({ webhook: { id: 1 } }));
    } });
    expect(await connector.verifyWebhook(store, new Request("http://test", { method: "POST", body, headers: { "x-shopify-hmac-sha256": signature, "x-shopify-event-id": "evt-1", "x-shopify-topic": "refunds/create" } }))).toEqual({ ok: true, value: { id: "evt-1", type: "refunds/create", data: { id: 1 } } });
    expect((await connector.verifyWebhook(store, new Request("http://test", { method: "POST", body: `${body}x`, headers: { "x-shopify-hmac-sha256": signature, "x-shopify-event-id": "evt-1", "x-shopify-topic": "refunds/create" } }))).ok).toBe(false);
    expect(await connector.registerWebhooks!(store, ["refunds/create"], "/api/channels/webhooks/store-1")).toEqual({ ok: true, value: { registered: 1 } });
  });
});
