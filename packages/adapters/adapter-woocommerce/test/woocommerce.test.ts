import { describe, expect, it } from "vitest";
import { catalogItem, wooProductSchema, wooVariationSchema } from "../src/catalog.js";
import { wooConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "woocommerce", credentials: { consumerKey: `ck_${"a".repeat(40)}`, consumerSecret: `cs_${"b".repeat(40)}`, authMode: "header", restRoute: "pretty", currency: "USD", priceDecimals: 2 }, storeDomain: "https://shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

/** WooCommerce answers JSON with its content type; the adapter reads anything else as a firewall page. */
function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json; charset=UTF-8", ...init.headers } });
}

describe("woocommerce connector: catalogue push", () => {
  it("pushes native product fields with their remote keys", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const connector = wooConnector({ fetchImpl: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json(({ id: 501 }));
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
      return json(({ id: 502 }));
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
      return json(({ id: 502 }));
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
      if (method === "GET") return json(({ images: [
        { id: 77, src: "https://cdn.shop.example/imported.jpg", alt: "Old imported alt", position: 0 },
        { id: 88, src: "https://cdn.shop.example/merchant.jpg", alt: "Merchant image", position: 1 },
      ] }));
      return json(({ id: 501 }));
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
      return json(({ id: 501 }));
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
      return json(({ id: 501 }));
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
      return json(({ id: 501 }));
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

  it("maps tag intent to product tags", async () => {
    let body: Record<string, unknown> | undefined;
    const connector = wooConnector({ fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(({ id: 501 }));
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
        return json(({ attributes: [
          { id: 9, name: "Material", visible: true, variation: false, options: ["wool"] },
          { id: 10, name: "Merchant", visible: true, variation: false, options: ["handmade"] },
        ] }));
      }
      if (url.pathname === "/wp-json/wc/v3/products/attributes" && (!init?.method || init.method === "GET")) return json(([]));
      if (url.pathname === "/wp-json/wc/v3/products/attributes/11/terms" && (!init?.method || init.method === "GET")) return json(([]));
      if (init?.method === "POST" && url.pathname === "/wp-json/wc/v3/products/attributes") return json(({ id: 11, name: "material", slug: "pa_material" }));
      if (init?.method === "POST" && url.pathname === "/wp-json/wc/v3/products/attributes/11/terms") return json(({ id: 21, name: "linen" }));
      return json(({ id: 501 }));
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
      return json(({ update: [{ id: 501 }, { id: 502 }] }));
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
    const connector = wooConnector({ fetchImpl: async () => json(({ update: [
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
      return json(({ update: body.update.map(({ id }) => ({ id })) }));
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
    const definitive = wooConnector({ fetchImpl: async () => json({ code: "rest_invalid_param", message: "Invalid parameter(s)." }, { status: 422 }) });
    const retriable = wooConnector({ fetchImpl: async () => json({ code: "internal_server_error", message: "Try again." }, { status: 503 }) });
    const item = { externalId: "501", fields: [{ fieldPath: "attributes.en.title", intent: "display" as const, value: "Broken", remoteKey: "name" }] };

    const definitiveResult = await definitive.pushCatalog!(store, [item]);
    const retriableResult = await retriable.pushCatalog!(store, [item]);

    expect(definitiveResult).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: false } }] } });
    expect(retriableResult).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: true } }] } });
  });

  it("classifies catalog 408 and 429 responses as retriable but 422 as definitive", async () => {
    const item = { externalId: "501", fields: [{ fieldPath: "attributes.en.title", intent: "display" as const, value: "Broken", remoteKey: "name" }] };
    const resultFor = (status: number) => wooConnector({ fetchImpl: async () => json({ code: "error", message: "No." }, { status }) }).pushCatalog!(store, [item]);

    const timeout = await resultFor(408);
    const rateLimited = await resultFor(429);
    const invalid = await resultFor(422);

    expect(timeout).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: true } }] } });
    expect(rateLimited).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: true } }] } });
    expect(invalid).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_API_FAILED", retriable: false } }] } });
  });


  // A web page where the API should be is a firewall or a security plugin in front of the store,
  // not WooCommerce: named as such so the merchant is told what to allow, and retried.
  it("reads an HTML answer as a firewall in front of the store, retriable", async () => {
    const item = { externalId: "501", fields: [{ fieldPath: "attributes.en.title", intent: "display" as const, value: "Blocked", remoteKey: "name" }] };
    const blocked = wooConnector({ fetchImpl: async () => new Response("<html><title>Just a moment...</title></html>", { status: 403, headers: { "content-type": "text/html" } }) });
    expect(await blocked.pushCatalog!(store, [item])).toMatchObject({ ok: true, value: { outcomes: [{ externalId: "501", ok: false, error: { code: "WOO_BLOCKED_BY_FIREWALL", retriable: true } }] } });
  });
});

describe("woocommerce connector: delivery identity", () => {
  async function deliver(body: Record<string, unknown>) {
    const { createHmac } = await import("node:crypto");
    const text = JSON.stringify(body);
    const request = new Request("https://platform.example/api/channels/webhooks/store-1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-wc-webhook-topic": "product.updated", "x-wc-webhook-signature": createHmac("sha256", store.webhookSecret).update(text, "utf8").digest("base64") },
      body: text,
    });
    const verified = await wooConnector().verifyWebhook!(store, request);
    if (!verified.ok || verified.value === null) throw new Error("delivery did not verify");
    return verified.value.id;
  }

  // date_modified_gmt is to the second: two stock changes inside one second (two orders, two edits)
  // report the same topic, id, status and time, and differ only in what changed.
  it("gives two changes in one second different ids", async () => {
    const at = { id: 31, status: "publish", date_modified_gmt: "2026-10-04T13:05:18" };
    expect(await deliver({ ...at, stock_quantity: 3 })).not.toBe(await deliver({ ...at, stock_quantity: 4 }));
  });

  it("gives a replay of one delivery the same id", async () => {
    const body = { id: 31, status: "publish", date_modified_gmt: "2026-10-04T13:05:18", stock_quantity: 3 };
    expect(await deliver(body)).toBe(await deliver(body));
  });
});

describe("woocommerce connector: brand", () => {
  const product = (brands: unknown) => wooProductSchema.parse({ id: 31, name: "Beanie", type: "simple", price: "4500", regular_price: "4500", sale_price: "", ...(brands === undefined ? {} : { brands }) });

  // WooCommerce 9.6+ ships Brands in core and lists them on the product; Shopify's equivalent is `vendor`.
  it("imports the product's first brand by name", () => {
    expect(catalogItem(product([{ id: 4, name: "Colombo Threads", slug: "colombo-threads" }]), [], "LKR").brand).toBe("Colombo Threads");
  });

  it("names no brand when the product has none, or the store predates Brands", () => {
    expect("brand" in catalogItem(product([]), [], "LKR")).toBe(false);
    expect("brand" in catalogItem(product(undefined), [], "LKR")).toBe(false);
  });
});

describe("woocommerce connector: identifiers and copy agents read", () => {
  // WooCommerce REST v3: `global_unique_id` is the product's or variation's GTIN/UPC/EAN/ISBN (core
  // since 9.2); `short_description` is the summary the product page shows above the cart button.
  const simple = (extra: Record<string, string>) => wooProductSchema.parse({ id: 41, name: "Sarong", type: "simple", price: "4500", regular_price: "4500", sale_price: "", ...extra });

  it("imports a simple product's global unique id as its variant's barcode", () => {
    expect(catalogItem(simple({ global_unique_id: "4006381333931" }), [], "LKR").variants[0]?.barcode).toBe("4006381333931");
  });

  it("imports a variation's global unique id as that variant's barcode, and names none when absent", () => {
    const variable = wooProductSchema.parse({ id: 42, name: "Kurta", type: "variable", attributes: [{ name: "Colour", variation: true, options: ["Red", "Blue"] }], variations: [43, 44] });
    const red = wooVariationSchema.parse({ id: 43, sku: "K-RED", price: "6200", regular_price: "6200", sale_price: "", global_unique_id: "0012345678905", attributes: [{ name: "Colour", option: "Red" }] });
    const blue = wooVariationSchema.parse({ id: 44, sku: "K-BLUE", price: "6400", regular_price: "6400", sale_price: "", attributes: [{ name: "Colour", option: "Blue" }] });
    const item = catalogItem(variable, [red, blue], "LKR");
    expect(item.variants.find((row) => row.externalId === "43")?.barcode).toBe("0012345678905");
    expect("barcode" in (item.variants.find((row) => row.externalId === "44") ?? {})).toBe(false);
  });

  it("imports the short description, summary first, beside the long one", () => {
    const item = catalogItem(simple({ short_description: "<p>Handloom cotton.</p>", description: "<p>Woven in Galle.</p>" }), [], "LKR");
    expect(item.description).toBe("<p>Handloom cotton.</p>\n\n<p>Woven in Galle.</p>");
    expect(catalogItem(simple({ short_description: "<p>Only a summary.</p>" }), [], "LKR").description).toBe("<p>Only a summary.</p>");
  });
});
