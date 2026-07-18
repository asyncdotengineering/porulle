import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { wooConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "woocommerce", credentials: { consumerKey: "ck", consumerSecret: "cs" }, storeDomain: "https://shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

describe("woocommerce connector", () => {
  it("paginates products and maps inventory", async () => {
    const urls: string[] = [];
    const connector = wooConnector({ fetchImpl: async (input) => {
      urls.push(String(input));
      const page = new URL(String(input)).searchParams.get("page");
      return new Response(JSON.stringify(page === "1" ? [{ id: 1, name: "First", slug: "first", variations: [{ id: 11, sku: "SKU", price: "8.50" }], stock_quantity: 7 }] : [{ id: 2, name: "Second", slug: "second", variations: [] }]), { headers: { "X-WP-TotalPages": "2" } });
    } });
    const first = await connector.importCatalog(store);
    expect(first.ok && first.value.items[0]).toMatchObject({ externalId: "1", variants: [{ externalId: "11", sku: "SKU", metadata: { price: 850 } }] });
    expect(first.ok && first.value.nextCursor).toBe("2");
    const second = await connector.importCatalog(store, first.ok ? first.value.nextCursor ?? undefined : undefined);
    expect(second.ok && second.value.items[0]?.externalId).toBe("2");
    const inventory = await connector.fetchInventory(store, ["1"]);
    expect(inventory).toEqual({ ok: true, value: [{ externalId: "1", available: 7 }] });
    expect(urls[0]).toContain("consumer_key=ck");
    expect(urls[0]).toContain("consumer_secret=cs");
    const incremental = await connector.importCatalog(store, "2026-01-01T00:00:00.000Z");
    expect(incremental.ok).toBe(true);
    expect(urls[3]).toContain("modified_after=2026-01-01T00%3A00%3A00.000Z");
  });

  it("returns API errors", async () => {
    const connector = wooConnector({ fetchImpl: async () => new Response("", { status: 500 }) });
    const result = await connector.importCatalog(store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("WOO_API_FAILED");
  });

  it("injects a paid order and maps remote status", async () => {
    let body = "";
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ id: 42 }));
    } });
    const pushed = await connector.pushOrder(store, {
      orderId: "order-1",
      currency: "USD",
      grandTotal: 2500,
      lines: [{ externalVariantId: "11", title: "Lamp", quantity: 2, unitPrice: 1250, totalPrice: 2500 }],
      customer: { name: "Priya Shopper", email: "priya@example.test", shippingAddress: { address1: "1 Main St", city: "Colombo", country: "LK" } },
    });
    expect(pushed).toEqual({ ok: true, value: { remoteOrderId: "42", remoteUrl: expect.stringContaining("post.php") } });
    expect(JSON.parse(body)).toMatchObject({ set_paid: true, line_items: [{ variation_id: "11", total: 25 }], billing: { email: "priya@example.test" } });
    const status = wooConnector({ fetchImpl: async () => new Response(JSON.stringify({ status: "completed" })) });
    expect(await status.fetchOrderStatus(store, "42")).toEqual({ ok: true, value: { status: "fulfilled" } });
    const failed = wooConnector({ fetchImpl: async () => new Response("", { status: 500 }) });
    const error = await failed.pushOrder(store, { orderId: "order-1", currency: "USD", grandTotal: 0, lines: [], customer: { name: "", email: "a@test", shippingAddress: {} } });
    expect(error.ok).toBe(false);
    if (!error.ok) expect(error.error.retriable).toBe(true);
  });

  it("verifies raw-body HMAC and registers webhook subscriptions", async () => {
    const body = JSON.stringify({ id: 1 });
    const signature = createHmac("sha256", store.webhookSecret).update(body).digest("base64");
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ topic: "refunds/create", delivery_url: "/api/channels/webhooks/store-1", secret: "webhook-secret" });
      return new Response(JSON.stringify({ id: 1 }));
    } });
    expect(await connector.verifyWebhook(store, new Request("http://test", { method: "POST", body, headers: { "x-wc-webhook-signature": signature, "x-wc-webhook-id": "evt-1", "x-wc-webhook-topic": "refunds/create" } }))).toEqual({ ok: true, value: { id: "evt-1", type: "refunds/create", data: { id: 1 } } });
    expect((await connector.verifyWebhook(store, new Request("http://test", { method: "POST", body: `${body}x`, headers: { "x-wc-webhook-signature": signature, "x-wc-webhook-id": "evt-1", "x-wc-webhook-topic": "refunds/create" } }))).ok).toBe(false);
    expect(await connector.registerWebhooks!(store, ["refunds/create"], "/api/channels/webhooks/store-1")).toEqual({ ok: true, value: { registered: 1 } });
  });
});
