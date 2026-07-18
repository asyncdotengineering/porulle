import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { shopifyConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "shopify", credentials: { accessToken: "token" }, storeDomain: "shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

describe("shopify connector", () => {
  it("builds the Shopify authorize URL with required and additive scopes", () => {
    const connector = shopifyConnector({
      clientId: "client-id",
      clientSecret: "client-secret",
      appUrl: "https://app.example",
      scopes: ["read_orders", "write_products"],
    });
    const result = connector.buildAuthUrl!({
      storeDomain: "acme.myshopify.com",
      state: "signed-state",
      redirectUri: "https://app.example/api/channels/oauth/shopify/callback",
      callbackUri: "https://app.example/api/channels/oauth/shopify/callback",
      scopes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.value);
    expect(url.origin).toBe("https://acme.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/channels/oauth/shopify/callback");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("scope")?.split(",")).toEqual([
      "read_products",
      "read_inventory",
      "read_orders",
      "write_orders",
      "read_fulfillments",
      "write_products",
    ]);
  });

  it("exchanges a signed Shopify callback and rejects invalid or stale callbacks", async () => {
    const secret = "client-secret";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const buildRequest = (at: string, hmacSecret = secret) => {
      const url = new URL("https://app.example/api/channels/oauth/shopify/callback");
      url.searchParams.set("code", "oauth-code");
      url.searchParams.set("shop", "acme.myshopify.com");
      url.searchParams.set("state", "signed-state");
      url.searchParams.set("timestamp", at);
      const message = [...url.searchParams.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
      url.searchParams.set("hmac", createHmac("sha256", hmacSecret).update(message).digest("hex"));
      return new Request(url, { method: "GET" });
    };
    const connector = shopifyConnector({
      clientId: "client-id",
      clientSecret: secret,
      appUrl: "https://app.example",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://acme.myshopify.com/admin/oauth/access_token");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ client_id: "client-id", client_secret: secret, code: "oauth-code" });
        return new Response(JSON.stringify({ access_token: "shpat_oauth" }));
      },
    });
    expect(await connector.completeAuth!(buildRequest(timestamp), { storeDomain: "acme.myshopify.com" })).toEqual({
      ok: true,
      value: { credentials: { accessToken: "shpat_oauth" }, storeDomain: "acme.myshopify.com" },
    });
    const invalid = await connector.completeAuth!(buildRequest(timestamp, "wrong-secret"), { storeDomain: "acme.myshopify.com" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("SHOPIFY_INVALID_OAUTH_HMAC");
    const stale = await connector.completeAuth!(buildRequest((Number(timestamp) - 301).toString()), { storeDomain: "acme.myshopify.com" });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("SHOPIFY_STALE_OAUTH_CALLBACK");
    const invalidDomain = await connector.buildAuthUrl!({
      storeDomain: "attacker.example",
      state: "state",
      redirectUri: "https://app.example/callback",
      callbackUri: "https://app.example/callback",
      scopes: [],
    });
    expect(invalidDomain.ok).toBe(false);
    if (!invalidDomain.ok) expect(invalidDomain.error.code).toBe("SHOPIFY_INVALID_STORE_DOMAIN");
  });

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

  it("verifies raw-body HMAC with the app client secret and registers webhook subscriptions", async () => {
    const body = JSON.stringify({ id: 1 });
    // Shopify signs every webhook for an app with the app CLIENT SECRET (not a per-store
    // secret). store.webhookSecret ("webhook-secret") is intentionally different here to
    // prove verification uses the app secret.
    const APP_SECRET = "app-client-secret";
    const signature = createHmac("sha256", APP_SECRET).update(body).digest("base64");
    const connector = shopifyConnector({ clientSecret: APP_SECRET, fetchImpl: async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ webhook: { topic: "refunds/create", address: "/api/channels/webhooks/store-1", format: "json" } });
      return new Response(JSON.stringify({ webhook: { id: 1 } }));
    } });
    expect(await connector.verifyWebhook(store, new Request("http://test", { method: "POST", body, headers: { "x-shopify-hmac-sha256": signature, "x-shopify-event-id": "evt-1", "x-shopify-topic": "refunds/create" } }))).toEqual({ ok: true, value: { id: "evt-1", type: "refunds/create", data: { id: 1 } } });
    expect((await connector.verifyWebhook(store, new Request("http://test", { method: "POST", body: `${body}x`, headers: { "x-shopify-hmac-sha256": signature, "x-shopify-event-id": "evt-1", "x-shopify-topic": "refunds/create" } }))).ok).toBe(false);
    expect(await connector.registerWebhooks!(store, ["refunds/create"], "/api/channels/webhooks/store-1")).toEqual({ ok: true, value: { registered: 1 } });
  });
});
