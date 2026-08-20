import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { shopifyConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "shopify", credentials: { accessToken: "token" }, storeDomain: "shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

const fullShopifyProduct = {
  id: 101,
  title: "Trail Boot",
  handle: "trail-boot",
  body_html: "<p>Built for wet trails.</p>",
  vendor: "Summit Supply",
  product_type: "Trail Boots",
  tags: "outdoor, waterproof, trail",
  status: "active",
  images: [
    { id: 1001, src: "https://cdn.shop.example/trail-boot.jpg", alt: "Brown trail boot", position: 1, variant_ids: [10001] },
    { id: 1002, src: "https://cdn.shop.example/trail-boot-side.jpg", alt: "Trail boot side", position: 2, variant_ids: [10002] },
  ],
  options: [
    { name: "Size", position: 1, values: ["42", "43"] },
    { name: "Color", position: 2, values: ["Brown", "Black"] },
  ],
  variants: [
    { id: 10001, sku: "TB-42-BRN", barcode: "100010001", price: "99.90", compare_at_price: "129.90", option1: "42", option2: "Brown" },
    { id: 10002, sku: "TB-43-BLK", barcode: "100020002", price: "109.90", compare_at_price: "139.90", option1: "43", option2: "Black" },
  ],
};

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
        return new Response(JSON.stringify({ access_token: "shpat_oauth", scope: "read_products,write_products,read_orders" }));
      },
    });
    expect(await connector.completeAuth!(buildRequest(timestamp), { storeDomain: "acme.myshopify.com" })).toEqual({
      ok: true,
      value: {
        credentials: {
          accessToken: "shpat_oauth",
          grantedScopes: ["read_products", "write_products", "read_orders"],
        },
        storeDomain: "acme.myshopify.com",
      },
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
      const url = String(input);
      requests.push(`${url} ${init?.headers ? (init.headers as Record<string, string>)["x-shopify-access-token"] : ""}`);
      if (url.endsWith("/shop.json")) return new Response(JSON.stringify({ shop: { currency: "USD" } }));
      if (url.includes("page_info=next")) return new Response(JSON.stringify({ products: [{ id: 2, title: "Second", handle: "second", variants: [] }] }), { headers: { link: "" } });
      return new Response(JSON.stringify({ products: [{ id: 1, title: "First", handle: "first", variants: [{ id: 11, sku: "SKU", barcode: "BAR", price: "12.34" }] }] }), { headers: { link: '<https://shop.example/admin/api/2024-10/products.json?limit=250&page_info=next>; rel="next"' } });
    } });
    const first = await connector.importCatalog(store);
    expect(first.ok && first.value.items[0]).toMatchObject({ externalId: "1", slug: "first", variants: [{ externalId: "11", sku: "SKU", barcode: "BAR", prices: [{ currency: "USD", amount: 1234 }] }] });
    expect(first.ok && first.value.nextCursor).toContain("page_info=next");
    const second = await connector.importCatalog(store, first.ok ? first.value.nextCursor ?? undefined : undefined);
    expect(second.ok && second.value.items[0]?.externalId).toBe("2");
    expect(requests.every((request) => request.endsWith(" token"))).toBe(true);
  });

  it("maps the complete Shopify product payload into the catalog contract", async () => {
    const requests: string[] = [];
    const connector = shopifyConnector({ fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/shop.json")) return new Response(JSON.stringify({ shop: { currency: "USD" } }));
      return new Response(JSON.stringify({ products: [fullShopifyProduct] }));
    } });

    const result = await connector.importCatalog(store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([{
      externalId: "101",
      slug: "trail-boot",
      title: "Trail Boot",
      attributes: [{ locale: "en", title: "Trail Boot", description: "<p>Built for wet trails.</p>" }],
      variants: [
        {
          externalId: "10001",
          sku: "TB-42-BRN",
          barcode: "100010001",
          optionValues: { Size: "42", Color: "Brown" },
          prices: [{ currency: "USD", amount: 9990, compareAtAmount: 12990 }],
        },
        {
          externalId: "10002",
          sku: "TB-43-BLK",
          barcode: "100020002",
          optionValues: { Size: "43", Color: "Black" },
          prices: [{ currency: "USD", amount: 10990, compareAtAmount: 13990 }],
        },
      ],
      images: [
        { externalId: "1001", url: "https://cdn.shop.example/trail-boot.jpg", alt: "Brown trail boot", role: "primary", sortOrder: 1, variantExternalIds: ["10001"] },
        { externalId: "1002", url: "https://cdn.shop.example/trail-boot-side.jpg", alt: "Trail boot side", role: "gallery", sortOrder: 2, variantExternalIds: ["10002"] },
      ],
      options: [
        { name: "Size", displayName: "Size", sortOrder: 1, values: [{ value: "42", displayValue: "42", sortOrder: 0 }, { value: "43", displayValue: "43", sortOrder: 1 }] },
        { name: "Color", displayName: "Color", sortOrder: 2, values: [{ value: "Brown", displayValue: "Brown", sortOrder: 0 }, { value: "Black", displayValue: "Black", sortOrder: 1 }] },
      ],
      tags: ["outdoor", "waterproof", "trail"],
      brand: "Summit Supply",
      categories: ["trail-boots"],
      status: "active",
    }]);
    expect(requests.filter((url) => url.endsWith("/shop.json"))).toHaveLength(1);
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

  it("writes native product fields and Porulle metafields with per-item outcomes", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const pushStore = {
      ...store,
      credentials: {
        accessToken: "token",
        grantedScopes: ["read_products", "write_products"],
      },
    };
    const connector = shopifyConnector({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/products/101.json") && method === "GET") {
          return new Response(JSON.stringify({
            product: {
              id: 101,
              title: "Old title",
              tags: "existing",
              updated_at: "2026-01-01T00:00:00Z",
            },
          }), { headers: { "x-shopify-shop-api-call-limit": "1/40" } });
        }
        if (url.includes("/products/101/metafields.json") && method === "GET") {
          return new Response(JSON.stringify({ metafields: [] }), { headers: { "x-shopify-shop-api-call-limit": "2/40" } });
        }
        if (url.endsWith("/products/101.json") && method === "PUT") {
          return new Response(JSON.stringify({ product: { id: 101, updated_at: "2026-01-02T00:00:00Z" } }), { headers: { "x-shopify-shop-api-call-limit": "3/40" } });
        }
        if (url.endsWith("/products/101/metafields.json") && method === "POST") {
          return new Response(JSON.stringify({ metafield: { id: 9001, namespace: "porulle", key: "seo_title", value: "SEO title" } }), { headers: { "x-shopify-shop-api-call-limit": "4/40" } });
        }
        if (url.endsWith("/products/102.json") && method === "GET") {
          return new Response("", { status: 422 });
        }
        return new Response("", { status: 404 });
      },
    });

    const result = await connector.pushCatalog!(pushStore, [
      {
        externalId: "101",
        fields: [
          { fieldPath: "attributes.en.title", intent: "display", value: "Trail Boot", remoteKey: "title" },
          { fieldPath: "attributes.en.seoTitle", intent: "display", value: "SEO title", remoteKey: "seo_title" },
          { fieldPath: "entity.metadata.featured", intent: "tag", value: "featured" },
        ],
      },
      {
        externalId: "102",
        fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "Broken", remoteKey: "title" }],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcomes).toEqual([
      {
        externalId: "101",
        ok: true,
        remoteUpdatedAt: "2026-01-02T00:00:00Z",
        previousFields: [
          { fieldPath: "attributes.en.title", value: "Old title" },
          { fieldPath: "attributes.en.seoTitle", value: null },
          { fieldPath: "entity.metadata.featured", value: null },
        ],
      },
      {
        externalId: "102",
        ok: false,
        error: {
          code: "SHOPIFY_API_FAILED",
          message: expect.stringContaining("422"),
          retriable: false,
        },
      },
    ]);
    expect(requests.find((request) => request.method === "PUT" && request.url.endsWith("/products/101.json"))?.body).toEqual({
      product: {
        id: "101",
        title: "Trail Boot",
        tags: "existing, featured",
      },
    });
    expect(requests.find((request) => request.method === "POST" && request.url.endsWith("/products/101/metafields.json"))?.body).toEqual({
      metafield: {
        namespace: "porulle",
        key: "seo_title",
        value: "SEO title",
        type: "single_line_text_field",
      },
    });
  });

  it("reports a missing remote key without writing a guessed native field", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const pushStore = {
      ...store,
      credentials: { accessToken: "token", grantedScopes: ["write_products"] },
    };
    const connector = shopifyConnector({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/products/101.json") && method === "GET") {
          return new Response(JSON.stringify({ product: { id: 101, title: "Old title" } }));
        }
        if (url.includes("/products/101/metafields.json") && method === "GET") {
          return new Response(JSON.stringify({ metafields: [] }));
        }
        if (url.endsWith("/products/101.json") && method === "PUT") {
          return new Response(JSON.stringify({ product: { id: 101, title: "Derived" } }));
        }
        return new Response("", { status: 404 });
      },
    });

    const result = await connector.pushCatalog!(pushStore, [{
      externalId: "101",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "Derived" }],
    }]);

    expect(result).toEqual({
      ok: true,
      value: {
        outcomes: [{
          externalId: "101",
          ok: false,
          error: {
            code: "SHOPIFY_REMOTE_KEY_REQUIRED",
            message: "Shopify catalog field attributes.en.title requires a remoteKey.",
            retriable: false,
          },
        }],
      },
    });
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("uses an explicit non-native remote key as a metafield name", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const pushStore = {
      ...store,
      credentials: { accessToken: "token", grantedScopes: ["write_products"] },
    };
    const connector = shopifyConnector({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/products/101.json") && method === "GET") {
          return new Response(JSON.stringify({ product: { id: 101, title: "Old title" } }));
        }
        if (url.includes("/products/101/metafields.json") && method === "GET") {
          return new Response(JSON.stringify({ metafields: [] }));
        }
        if (url.endsWith("/products/101/metafields.json") && method === "POST") {
          return new Response(JSON.stringify({ metafield: { id: 9002, namespace: "porulle", key: "custom_title", value: "Remapped title" } }));
        }
        if (url.endsWith("/products/101.json") && method === "PUT") {
          return new Response(JSON.stringify({ product: { id: 101, title: "Unexpected native title" } }));
        }
        return new Response("", { status: 404 });
      },
    });

    const result = await connector.pushCatalog!(pushStore, [{
      externalId: "101",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "Remapped title", remoteKey: "custom_title" }],
    }]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcomes[0]).toMatchObject({ externalId: "101", ok: true });
    expect(requests.find((request) => request.method === "POST")?.body).toEqual({
      metafield: {
        namespace: "porulle",
        key: "custom_title",
        value: "Remapped title",
        type: "single_line_text_field",
      },
    });
    expect(requests.some((request) => request.method === "PUT" && request.url.endsWith("/products/101.json"))).toBe(false);
  });

  it("writes variant native fields once and scopes variant metafields to the variant", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const pushStore = {
      ...store,
      credentials: { accessToken: "token", grantedScopes: ["write_products"] },
    };
    const connector = shopifyConnector({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/products/101.json") && method === "GET") {
          return new Response(JSON.stringify({
            product: {
              id: 101,
              variants: [{ id: 201, sku: "OLD-SKU", barcode: "OLD-BARCODE" }],
            },
          }));
        }
        if (url.includes("/products/101/metafields.json") && method === "GET") {
          return new Response(JSON.stringify({ metafields: [] }));
        }
        if (url.includes("/variants/201/metafields.json") && method === "GET") {
          return new Response(JSON.stringify({ metafields: [] }));
        }
        if (url.endsWith("/variants/201.json") && method === "PUT") {
          return new Response(JSON.stringify({ variant: { id: 201, sku: "NEW-SKU" } }));
        }
        if (url.endsWith("/products/101/metafields.json") && method === "POST") {
          return new Response(JSON.stringify({ metafield: { id: 9101, namespace: "porulle", key: "variant_note", value: "New note" } }));
        }
        if (url.endsWith("/variants/201/metafields.json") && method === "POST") {
          return new Response(JSON.stringify({ metafield: { id: 9101, namespace: "porulle", key: "variant_note", value: "New note" } }));
        }
        return new Response("", { status: 404 });
      },
    });

    const result = await connector.pushCatalog!(pushStore, [{
      externalId: "101",
      fields: [],
      variants: [{
        externalId: "201",
        fields: [
          { fieldPath: "variants.sku", intent: "display", value: "NEW-SKU", remoteKey: "sku" },
          { fieldPath: "variants.metadata.note", intent: "display", value: "New note", remoteKey: "variant_note" },
        ],
      }],
    }]);

    expect(result).toEqual({
      ok: true,
      value: {
        outcomes: [{
          externalId: "101",
          ok: true,
          previousFields: [
            { fieldPath: "variants.sku", value: "OLD-SKU" },
            { fieldPath: "variants.metadata.note", value: null },
          ],
        }],
      },
    });
    expect(requests.filter((request) => request.method === "PUT" && request.url.endsWith("/variants/201.json"))).toHaveLength(1);
    expect(requests.find((request) => request.method === "PUT" && request.url.endsWith("/variants/201.json"))?.body).toEqual({ variant: { id: "201", sku: "NEW-SKU" } });
    expect(requests.find((request) => request.method === "POST" && request.url.endsWith("/variants/201/metafields.json"))?.body).toEqual({
      metafield: {
        namespace: "porulle",
        key: "variant_note",
        value: "New note",
        type: "single_line_text_field",
      },
    });
    expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/products/101/metafields.json"))).toBe(false);
  });

  it("reports product images as not written instead of confirming the item", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const pushStore = {
      ...store,
      credentials: { accessToken: "token", grantedScopes: ["write_products"] },
    };
    const connector = shopifyConnector({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (url.endsWith("/products/101.json") && method === "GET") {
          return new Response(JSON.stringify({ product: { id: 101 } }));
        }
        if (url.includes("/products/101/metafields.json") && method === "GET") {
          return new Response(JSON.stringify({ metafields: [] }));
        }
        return new Response("", { status: 404 });
      },
    });

    const result = await connector.pushCatalog!(pushStore, [{
      externalId: "101",
      fields: [],
      images: [{ url: "https://cdn.shop.example/boot.jpg", role: "primary" }],
    }]);

    expect(result).toEqual({
      ok: true,
      value: {
        outcomes: [{
          externalId: "101",
          ok: false,
          error: {
            code: "SHOPIFY_IMAGES_NOT_WRITTEN",
            message: "Shopify catalog image pushes are not written by this adapter.",
            retriable: false,
          },
        }],
      },
    });
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("does not update a foreign-namespace metafield with the same key", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const pushStore = {
      ...store,
      credentials: { accessToken: "token", grantedScopes: ["write_products"] },
    };
    const connector = shopifyConnector({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, method, body });
        if (url.endsWith("/products/101.json") && method === "GET") {
          return new Response(JSON.stringify({ product: { id: 101 } }));
        }
        if (url.includes("/products/101/metafields.json") && method === "GET") {
          return new Response(JSON.stringify({ metafields: [{ id: 9900, namespace: "merchant", key: "seo_title", value: "Merchant SEO" }] }));
        }
        if (url.endsWith("/metafields/9900.json") && method === "PUT") {
          return new Response(JSON.stringify({ metafield: { id: 9900, namespace: "merchant", key: "seo_title", value: "Overwritten" } }));
        }
        if (url.endsWith("/products/101/metafields.json") && method === "POST") {
          return new Response(JSON.stringify({ metafield: { id: 9901, namespace: "porulle", key: "seo_title", value: "Porulle SEO" } }));
        }
        return new Response("", { status: 404 });
      },
    });

    const result = await connector.pushCatalog!(pushStore, [{
      externalId: "101",
      fields: [{ fieldPath: "attributes.en.seoTitle", intent: "display", value: "Porulle SEO", remoteKey: "seo_title" }],
    }]);

    expect(result).toEqual({
      ok: true,
      value: {
        outcomes: [{
          externalId: "101",
          ok: true,
          previousFields: [{ fieldPath: "attributes.en.seoTitle", value: null }],
        }],
      },
    });
    expect(requests.some((request) => request.method === "PUT" && request.url.endsWith("/metafields/9900.json"))).toBe(false);
    expect(requests.find((request) => request.method === "POST" && request.url.endsWith("/products/101/metafields.json"))?.body).toMatchObject({
      metafield: { namespace: "porulle", key: "seo_title" },
    });
  });

  it("returns a scope error for stores missing write_products and supports dry-run", async () => {
    const requests: string[] = [];
    const scopelessStore = {
      ...store,
      storeDomain: "acme.myshopify.com",
      credentials: { accessToken: "token", grantedScopes: ["read_products"] },
    };
    const connector = shopifyConnector({
      clientId: "client-id",
      clientSecret: "client-secret",
      appUrl: "https://app.example",
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({ product: { id: 101, title: "Old" } }));
      },
    });

    const blocked = await connector.pushCatalog!(scopelessStore, [{
      externalId: "101",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "New", remoteKey: "title" }],
    }]);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toMatchObject({
        code: "SHOPIFY_WRITE_PRODUCTS_SCOPE_MISSING",
        retriable: false,
      });
      expect(blocked.error.message).toContain("https://app.example/api/channels/oauth/shopify/start?shop=acme.myshopify.com");
      expect(blocked.error.message).not.toContain("/admin/oauth/authorize");
    }
    expect(requests).toEqual([]);

    const authorizedStore = {
      ...scopelessStore,
      credentials: { accessToken: "token", grantedScopes: ["write_products"] },
    };
    const dryRun = await connector.pushCatalog!(authorizedStore, [{
      externalId: "101",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "New", remoteKey: "title" }],
    }], { dryRun: true });
    expect(dryRun.ok).toBe(true);
    if (dryRun.ok) expect(dryRun.value.outcomes).toEqual([{ externalId: "101", ok: true, previousFields: [{ fieldPath: "attributes.en.title", value: "Old" }] }]);
    expect(requests.filter((url) => url.includes("/products/101.json") && !url.includes("metafields"))).toHaveLength(1);
  });

  it("maps Shopify 403 and 429 responses to scope and rate-limit errors", async () => {
    const connector = shopifyConnector({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/products/403.json")) return new Response("", { status: 403 });
        if (url.endsWith("/products/403-write.json") && method === "PUT") return new Response("", { status: 403 });
        if (url.endsWith("/products/429.json") && method !== "GET") return new Response("", { status: 429 });
        if (url.includes("/metafields.json")) return new Response(JSON.stringify({ metafields: [] }));
        return new Response(JSON.stringify({ product: { id: 429, title: "Old" } }));
      },
    });
    const pushStore = {
      ...store,
      credentials: { accessToken: "token", grantedScopes: ["write_products"] },
    };

    const forbidden = await connector.pushCatalog!(pushStore, [{
      externalId: "403",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "New", remoteKey: "title" }],
    }]);
    expect(forbidden.ok).toBe(true);
    if (forbidden.ok) {
      expect(forbidden.value.outcomes[0]).toMatchObject({
        ok: false,
        error: { code: "SHOPIFY_API_FAILED", retriable: false },
      });
    }

    const mutatingForbidden = await connector.pushCatalog!(pushStore, [{
      externalId: "403-write",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "New", remoteKey: "title" }],
    }]);
    expect(mutatingForbidden.ok).toBe(true);
    if (mutatingForbidden.ok) {
      expect(mutatingForbidden.value.outcomes[0]).toMatchObject({
        ok: false,
        error: { code: "SHOPIFY_WRITE_PRODUCTS_SCOPE_MISSING", retriable: false },
      });
    }

    const limited = await connector.pushCatalog!(pushStore, [{
      externalId: "429",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "New", remoteKey: "title" }],
    }]);
    expect(limited.ok).toBe(true);
    if (limited.ok) {
      expect(limited.value.outcomes[0]).toMatchObject({
        ok: false,
        error: { code: "SHOPIFY_RATE_LIMITED", retriable: true },
      });
    }
  });
});
