import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { wooConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "woocommerce", credentials: { consumerKey: "ck", consumerSecret: "cs" }, storeDomain: "https://shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

const fullWooProduct = {
  id: 201,
  name: "Trail Boot",
  slug: "trail-boot",
  description: "Built for wet trails.",
  status: "publish",
  images: [
    { id: 3001, src: "https://cdn.shop.example/trail-boot.jpg", alt: "Brown trail boot", position: 0 },
    { id: 3002, src: "https://cdn.shop.example/trail-boot-side.jpg", alt: "Trail boot side", position: 1 },
  ],
  attributes: [
    { id: 1, name: "Size", variation: true, options: ["42", "43"] },
    { id: 2, name: "Color", variation: true, options: ["Brown", "Black"] },
    { id: 3, name: "Material", variation: false, options: ["Leather"] },
  ],
  tags: [
    { id: 1, name: "Outdoor", slug: "outdoor" },
    { id: 2, name: "Waterproof", slug: "waterproof" },
  ],
  categories: [
    { id: 1, name: "Footwear", slug: "footwear" },
    { id: 2, name: "Boots", slug: "boots" },
  ],
  variations: [2101, 2102],
};

const fullWooVariations = [
  { id: 2101, sku: "TB-42-BRN", price: "99.90", attributes: [{ name: "Size", option: "42" }, { name: "Color", option: "Brown" }] },
  { id: 2102, sku: "TB-43-BLK", price: "109.90", attributes: [{ name: "Size", option: "43" }, { name: "Color", option: "Black" }] },
];

describe("woocommerce connector", () => {
  it("builds auth URLs with state on both browser and server callbacks", () => {
    const connector = wooConnector();
    const result = connector.buildAuthUrl!({
      storeDomain: "https://shop.example",
      state: "signed-state",
      redirectUri: "https://app.example/api/channels/oauth/woocommerce/callback",
      callbackUri: "https://app.example/api/channels/oauth/woocommerce/callback",
      scopes: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.value);
    expect(url.origin).toBe("https://shop.example");
    expect(url.pathname).toBe("/wc-auth/v1/authorize");
    expect(url.searchParams.get("app_name")).toBe("Porulle");
    expect(url.searchParams.get("scope")).toBe("read_write");
    const returnUrl = new URL(url.searchParams.get("return_url")!);
    const callbackUrl = new URL(url.searchParams.get("callback_url")!);
    expect(returnUrl.searchParams.get("state")).toBe("signed-state");
    expect(returnUrl.searchParams.get("return")).toBe("1");
    expect(callbackUrl.searchParams.get("state")).toBe("signed-state");
    expect(callbackUrl.searchParams.get("return")).toBeNull();
  });

  it("reads WooCommerce credentials from the server callback POST", async () => {
    const connector = wooConnector();
    const result = await connector.completeAuth!(new Request("https://app.example/callback?state=signed-state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumer_key: "ck_oauth", consumer_secret: "cs_oauth" }),
    }), { storeDomain: "https://shop.example" });
    expect(result).toEqual({
      ok: true,
      value: { credentials: { consumerKey: "ck_oauth", consumerSecret: "cs_oauth" }, storeDomain: "https://shop.example" },
    });
  });

  it("paginates products and maps inventory", async () => {
    const urls: string[] = [];
    const connector = wooConnector({ fetchImpl: async (input) => {
      const url = String(input);
      urls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/settings/general")) return new Response(JSON.stringify([{ id: "woocommerce_currency", value: "USD" }]));
      if (parsed.pathname.endsWith("/products/1/variations")) return new Response(JSON.stringify([{ id: 11, sku: "SKU", price: "8.50" }]), { headers: { "X-WP-TotalPages": "1" } });
      const page = parsed.searchParams.get("page");
      return new Response(JSON.stringify(page === "1" ? [{ id: 1, name: "First", slug: "first", variations: [{ id: 11, sku: "SKU", price: "8.50" }], stock_quantity: 7 }] : [{ id: 2, name: "Second", slug: "second", variations: [] }]), { headers: { "X-WP-TotalPages": "2" } });
    } });
    const first = await connector.importCatalog(store);
    expect(first.ok && first.value.items[0]).toMatchObject({ externalId: "1", variants: [{ externalId: "11", sku: "SKU", prices: [{ currency: "USD", amount: 850 }] }] });
    expect(first.ok && first.value.nextCursor).toBe("2");
    const second = await connector.importCatalog(store, first.ok ? first.value.nextCursor ?? undefined : undefined);
    expect(second.ok && second.value.items[0]?.externalId).toBe("2");
    const inventory = await connector.fetchInventory(store, ["1"]);
    expect(inventory).toEqual({ ok: true, value: [{ externalId: "1", available: 7 }] });
    expect(urls[0]).toContain("consumer_key=ck");
    expect(urls[0]).toContain("consumer_secret=cs");
    const incremental = await connector.importCatalog(store, "2026-01-01T00:00:00.000Z");
    expect(incremental.ok).toBe(true);
    expect(urls.some((url) => url.includes("modified_after=2026-01-01T00%3A00%3A00.000Z"))).toBe(true);
  });

  it("maps the complete WooCommerce variable-product payload into the catalog contract", async () => {
    const requests: string[] = [];
    const connector = wooConnector({ fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/settings/general")) return new Response(JSON.stringify([{ id: "woocommerce_currency", value: "USD" }]));
      if (pathname.endsWith("/products/201/variations")) return new Response(JSON.stringify(fullWooVariations), { headers: { "X-WP-TotalPages": "1" } });
      return new Response(JSON.stringify([fullWooProduct]), { headers: { "X-WP-TotalPages": "1" } });
    } });

    const result = await connector.importCatalog(store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toEqual([{
      externalId: "201",
      slug: "trail-boot",
      title: "Trail Boot",
      attributes: [{ locale: "en", title: "Trail Boot", description: "Built for wet trails." }],
      variants: [
        {
          externalId: "2101",
          sku: "TB-42-BRN",
          optionValues: { Size: "42", Color: "Brown" },
          prices: [{ currency: "USD", amount: 9990 }],
        },
        {
          externalId: "2102",
          sku: "TB-43-BLK",
          optionValues: { Size: "43", Color: "Black" },
          prices: [{ currency: "USD", amount: 10990 }],
        },
      ],
      images: [
        { externalId: "3001", url: "https://cdn.shop.example/trail-boot.jpg", alt: "Brown trail boot", role: "primary", sortOrder: 0 },
        { externalId: "3002", url: "https://cdn.shop.example/trail-boot-side.jpg", alt: "Trail boot side", role: "gallery", sortOrder: 1 },
      ],
      options: [
        { name: "Size", displayName: "Size", sortOrder: 0, values: [{ value: "42", displayValue: "42", sortOrder: 0 }, { value: "43", displayValue: "43", sortOrder: 1 }] },
        { name: "Color", displayName: "Color", sortOrder: 1, values: [{ value: "Brown", displayValue: "Brown", sortOrder: 0 }, { value: "Black", displayValue: "Black", sortOrder: 1 }] },
      ],
      tags: ["outdoor", "waterproof"],
      categories: ["footwear", "boots"],
      status: "active",
    }]);
    expect(requests.filter((url) => new URL(url).pathname.endsWith("/settings/general"))).toHaveLength(1);
    expect(requests.filter((url) => new URL(url).pathname.endsWith("/products/201/variations"))).toHaveLength(1);
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

  it("pushes native product fields with their remote keys", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const connector = wooConnector({ fetchImpl: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ id: 501 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [
        { fieldPath: "attributes.en.title", intent: "display", value: "Rain Jacket", locale: "en", remoteKey: "name" },
        { fieldPath: "attributes.en.description", intent: "display", value: "Waterproof shell.", locale: "en", remoteKey: "description" },
      ],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toBe("/wp-json/wc/v3/products/501");
    expect(requests[0]).toMatchObject({ method: "PUT", body: { name: "Rain Jacket", description: "Waterproof shell." } });
  });

  it("pushes variant native fields to the variation endpoint", async () => {
    const requests: string[] = [];
    const connector = wooConnector({ fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ id: 502 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [],
      variants: [{
        externalId: "502",
        fields: [{ fieldPath: "variants.sku", intent: "display", value: "RJ-RED-M", remoteKey: "sku" }],
      }],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    expect(new URL(requests[0]!).pathname).toBe("/wp-json/wc/v3/products/501/variations/502");
  });

  it("does not push variation attributes as a replacement array", async () => {
    let body: Record<string, unknown> | undefined;
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 502 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [],
      variants: [{
        externalId: "502",
        fields: [{ fieldPath: "variants.attributes", intent: "display", value: [{ name: "Size", option: "M" }], remoteKey: "attributes" }],
      }],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    expect(body).toEqual({ meta_data: [{ key: "porulle_attributes", value: [{ name: "Size", option: "M" }] }] });
  });

  it("read-merges product images and reuses imported attachment IDs", async () => {
    const requests: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
    const connector = wooConnector({ fetchImpl: async (input, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ url: String(input), method, body });
      if (method === "GET") return new Response(JSON.stringify({ images: [
        { id: 77, src: "https://cdn.shop.example/imported.jpg", alt: "Old imported alt", position: 0 },
        { id: 88, src: "https://cdn.shop.example/merchant.jpg", alt: "Merchant image", position: 1 },
      ] }));
      return new Response(JSON.stringify({ id: 501 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [],
      images: [{ externalId: "77", url: "https://cdn.shop.example/imported.jpg", alt: "Updated alt", role: "primary", sortOrder: 0 }],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
    expect(requests.every((request) => new URL(request.url).origin === "https://shop.example")).toBe(true);
    const images = requests[1]?.body?.images as Array<Record<string, unknown>>;
    expect(images).toEqual(expect.arrayContaining([
      { id: 77, alt: "Updated alt", position: 0 },
      { id: 88, alt: "Merchant image", position: 1 },
    ]));
    expect(images.find((image) => image.id === 77)).not.toHaveProperty("src");
  });

  it("places non-native display fields in Porulle-prefixed meta_data using remoteKey", async () => {
    let body: Record<string, unknown> | undefined;
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 501 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [
        { fieldPath: "attributes.en.title", intent: "display", value: "Mapped title", locale: "en", remoteKey: "custom_title" },
        { fieldPath: "attributes.en.seoTitle", intent: "display", value: null, locale: "en", remoteKey: "seo_title" },
      ],
    }]);

    expect(result.ok).toBe(true);
    expect(body).toEqual({ meta_data: [
      { key: "porulle_custom_title", value: "Mapped title" },
      { key: "porulle_seo_title", value: null },
    ] });
    expect((body?.meta_data as Array<{ key: string }>).every((entry) => !entry.key.startsWith("_"))).toBe(true);
  });

  it("gives English locale precedence when meta remote keys collide", async () => {
    let body: Record<string, unknown> | undefined;
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 501 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [
        { fieldPath: "attributes.fr.seoTitle", intent: "display", value: "Titre FR", locale: "fr", remoteKey: "seo_title" },
        { fieldPath: "attributes.en.seoTitle", intent: "display", value: "English title", locale: "en", remoteKey: "seo_title" },
      ],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    expect(body).toEqual({ meta_data: [{ key: "porulle_seo_title", value: "English title" }] });
  });

  it("gives English locale precedence regardless of field order", async () => {
    let body: Record<string, unknown> | undefined;
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 501 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [
        { fieldPath: "attributes.en.seoTitle", intent: "display", value: "English title", locale: "en", remoteKey: "seo_title" },
        { fieldPath: "attributes.fr.seoTitle", intent: "display", value: "Titre FR", locale: "fr", remoteKey: "seo_title" },
      ],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    expect(body).toEqual({ meta_data: [{ key: "porulle_seo_title", value: "English title" }] });
  });

  it("keeps pushOrder client errors definitive when the catalog path treats them as retriable", async () => {
    const connector = wooConnector({ fetchImpl: async () => new Response("", { status: 429 }) });

    const order = await connector.pushOrder(store, {
      orderId: "order-1",
      currency: "USD",
      grandTotal: 0,
      lines: [],
      customer: { name: "", email: "a@test", shippingAddress: {} },
    });
    const catalog = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "Retry me", locale: "en", remoteKey: "name" }],
    }]);

    expect(order.ok).toBe(false);
    expect(order.ok === false && order.error.retriable).toBe(false);
    expect(catalog).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { retriable: true } }] } });
  });

  it("maps tag intent to product tags", async () => {
    let body: Record<string, unknown> | undefined;
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: 501 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [{ fieldPath: "entity.metadata.color", intent: "tag", value: ["red", "blue"] }],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    expect(body).toEqual({ tags: [{ name: "red" }, { name: "blue" }] });
  });

  it("creates filterable global attributes and read-merges product attributes by id", async () => {
    const requests: Array<{ pathname: string; method: string; body: Record<string, unknown> | undefined }> = [];
    const connector = wooConnector({ fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      requests.push({ pathname: url.pathname, method: init?.method ?? "GET", body });
      if (url.pathname === "/wp-json/wc/v3/products/501" && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ attributes: [
          { id: 9, name: "Material", visible: true, variation: false, options: ["wool"] },
          { id: 10, name: "Merchant", visible: true, variation: false, options: ["handmade"] },
        ] }));
      }
      if (url.pathname === "/wp-json/wc/v3/products/attributes" && (!init?.method || init.method === "GET")) return new Response(JSON.stringify([]));
      if (url.pathname === "/wp-json/wc/v3/products/attributes/11/terms" && (!init?.method || init.method === "GET")) return new Response(JSON.stringify([]));
      if (init?.method === "POST" && url.pathname === "/wp-json/wc/v3/products/attributes") return new Response(JSON.stringify({ id: 11, name: "material", slug: "pa_material" }));
      if (init?.method === "POST" && url.pathname === "/wp-json/wc/v3/products/attributes/11/terms") return new Response(JSON.stringify({ id: 21, name: "linen" }));
      return new Response(JSON.stringify({ id: 501 }));
    } });

    const result = await connector.pushCatalog!(store, [{
      externalId: "501",
      fields: [{ fieldPath: "customFields.material.en", intent: "filterable", value: "linen", locale: "en", remoteKey: "material" }],
    }]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }] } });
    const update = requests.find((request) => request.pathname.endsWith("/products/501") && request.method === "PUT");
    expect(update?.body?.attributes).toHaveLength(3);
    expect(update?.body?.attributes).toEqual(expect.arrayContaining([
      { id: 9, name: "Material", visible: true, variation: false, options: ["wool"] },
      { id: 10, name: "Merchant", visible: true, variation: false, options: ["handmade"] },
      expect.objectContaining({ id: 11, options: ["linen"] }),
    ]));
  });

  it("uses the products batch endpoint for multiple simple product writes", async () => {
    let request: { url: string; method: string; body: Record<string, unknown> } | undefined;
    const connector = wooConnector({ fetchImpl: async (input, init) => {
      request = { url: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response(JSON.stringify({ update: [{ id: 501 }, { id: 502 }] }));
    } });

    const result = await connector.pushCatalog!(store, [
      { externalId: "501", fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "One", remoteKey: "name" }] },
      { externalId: "502", fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "Two", remoteKey: "name" }] },
    ]);

    expect(result).toEqual({ ok: true, value: { outcomes: [{ externalId: "501", ok: true }, { externalId: "502", ok: true }] } });
    expect(new URL(request!.url).pathname).toBe("/wp-json/wc/v3/products/batch");
    expect(request).toMatchObject({ method: "POST", body: { update: [{ id: 501, name: "One" }, { id: 502, name: "Two" }] } });
  });

  it("maps per-item errors in a successful batch response to only the rejected item", async () => {
    const connector = wooConnector({ fetchImpl: async () => new Response(JSON.stringify({ update: [
      { id: 601 },
      { id: 602, error: { code: "woocommerce_rest_invalid_product", message: "Product rejected.", data: { status: 422 } } },
    ] })) });

    const result = await connector.pushCatalog!(store, [
      { externalId: "601", fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "One", remoteKey: "name" }] },
      { externalId: "602", fields: [{ fieldPath: "attributes.en.title", intent: "display", value: "Two", remoteKey: "name" }] },
    ]);

    expect(result).toEqual({ ok: true, value: { outcomes: [
      { externalId: "601", ok: true },
      { externalId: "602", ok: false, error: { code: "WOO_API_FAILED", message: "Product rejected.", retriable: false } },
    ] } });
  });

  it("chunks batch writes at WooCommerce's 100-item limit", async () => {
    const batchSizes: number[] = [];
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { update: Array<{ id: number | string }> };
      batchSizes.push(body.update.length);
      return new Response(JSON.stringify({ update: body.update.map(({ id }) => ({ id })) }));
    } });
    const items = Array.from({ length: 101 }, (_, index) => ({
      externalId: String(700 + index),
      fields: [{ fieldPath: "attributes.en.title", intent: "display" as const, value: `Product ${index}`, remoteKey: "name" }],
    }));

    const result = await connector.pushCatalog!(store, items);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(batchSizes).toEqual([100, 1]);
    expect(result.value.outcomes).toHaveLength(101);
    expect(result.value.outcomes).toEqual(items.map((item) => ({ externalId: item.externalId, ok: true })));
  });

  it("returns one outcome per item and classifies definitive versus retriable HTTP failures", async () => {
    const definitive = wooConnector({ fetchImpl: async () => new Response("", { status: 422 }) });
    const retriable = wooConnector({ fetchImpl: async () => new Response("", { status: 503 }) });
    const item = { externalId: "501", fields: [{ fieldPath: "attributes.en.title", intent: "display" as const, value: "Broken", remoteKey: "name" }] };

    const definitiveResult = await definitive.pushCatalog!(store, [item]);
    const retriableResult = await retriable.pushCatalog!(store, [item]);

    expect(definitiveResult).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: false } }] } });
    expect(retriableResult).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: true } }] } });
  });

  it("classifies catalog 408 and 429 responses as retriable but 422 as definitive", async () => {
    const item = { externalId: "501", fields: [{ fieldPath: "attributes.en.title", intent: "display" as const, value: "Broken", remoteKey: "name" }] };
    const resultFor = (status: number) => wooConnector({ fetchImpl: async () => new Response("", { status }) }).pushCatalog!(store, [item]);

    const timeout = await resultFor(408);
    const rateLimited = await resultFor(429);
    const invalid = await resultFor(422);

    expect(timeout).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: true } }] } });
    expect(rateLimited).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: true } }] } });
    expect(invalid).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: false } }] } });
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
