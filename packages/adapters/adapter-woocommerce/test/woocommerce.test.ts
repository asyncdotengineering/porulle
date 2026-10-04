import { describe, expect, it } from "vitest";
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
