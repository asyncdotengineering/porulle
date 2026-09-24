/**
 * `fetchInventory` answers stock per VARIANT, the id every connector call site matches on.
 *
 * It asked `inventory_levels.json?limit=250` once and never followed `Link`, so on the sim a
 * 3,000-product store was levelled for 250 rows and no more. Against real Shopify it was worse:
 * that endpoint REQUIRES `inventory_item_ids` or `location_ids`, takes at most 50 ids, and keys
 * levels by INVENTORY ITEM id — not the variant id the connector matches — so a real store levelled
 * nothing at all. (https://shopify.dev/docs/api/admin-rest/latest/resources/inventorylevel)
 *
 * The fake below behaves as Shopify documents: products paged by `Link`, every variant with an
 * `inventory_item_id` distinct from its id, and an inventory_levels endpoint that refuses what
 * Shopify refuses. A fake more permissive than Shopify is how these defects stayed hidden.
 */
import { describe, expect, it } from "vitest";
import { shopifyConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "shopify", credentials: { accessToken: "token" }, storeDomain: "shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };
const ORIGIN = "https://shop.example";

interface FakeVariant { id: number; inventory_item_id: number; inventory_quantity: number }

function fakeShopify(productCount: number, quantity: (variantId: number) => number = (id) => id % 7) {
  const products = Array.from({ length: productCount }, (_, index) => {
    const id = 1_000 + index;
    const variant: FakeVariant = { id: 50_000 + index, inventory_item_id: 900_000 + index, inventory_quantity: quantity(50_000 + index) };
    return { id, variants: [variant] };
  });
  const variants = new Map(products.flatMap((product) => product.variants).map((variant) => [variant.id, variant]));
  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/products.json")) {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const start = Number(url.searchParams.get("page_info") ?? "0");
      const page = products.slice(start, start + limit);
      const headers = new Headers({ "content-type": "application/json" });
      if (start + limit < products.length) {
        headers.set("link", `<${ORIGIN}${url.pathname}?limit=${limit}&page_info=${start + limit}>; rel="next"`);
      }
      return new Response(JSON.stringify({ products: page }), { headers });
    }
    const variantMatch = /\/variants\/(\d+)\.json$/.exec(url.pathname);
    if (variantMatch) {
      const variant = variants.get(Number(variantMatch[1]));
      return variant ? Response.json({ variant }) : Response.json({ errors: "Not Found" }, { status: 404 });
    }
    if (url.pathname.endsWith("/inventory_levels.json")) {
      const itemIds = url.searchParams.get("inventory_item_ids");
      const locationIds = url.searchParams.get("location_ids");
      if (!itemIds && !locationIds) return Response.json({ errors: "inventory_item_ids or location_ids must be present" }, { status: 422 });
      if ((itemIds?.split(",").length ?? 0) > 50) return Response.json({ errors: "too many inventory_item_ids" }, { status: 422 });
      const wanted = new Set(itemIds?.split(","));
      const levels = [...variants.values()].filter((variant) => wanted.has(String(variant.inventory_item_id)))
        .map((variant) => ({ inventory_item_id: variant.inventory_item_id, location_id: 1, available: variant.inventory_quantity }));
      return Response.json({ inventory_levels: levels });
    }
    return new Response("", { status: 404 });
  };
  return { fetchImpl, requests, variants: [...variants.values()] };
}

describe("fetchInventory", () => {
  it("a full sync walks every page and levels EVERY variant, keyed by variant id", async () => {
    const shop = fakeShopify(510);
    const connector = shopifyConnector({ fetchImpl: shop.fetchImpl });

    const result = await connector.fetchInventory(store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(510);
    expect(new Map(result.value.map((level) => [level.externalId, level.available])))
      .toEqual(new Map(shop.variants.map((variant) => [String(variant.id), variant.inventory_quantity])));
  });

  it("budget: a full sync costs ceil(products / 250) requests, all to products.json", async () => {
    const shop = fakeShopify(510);
    await shopifyConnector({ fetchImpl: shop.fetchImpl }).fetchInventory(store);

    expect(shop.requests).toHaveLength(Math.ceil(510 / 250));
    expect(shop.requests.every((request) => request.includes("/products.json"))).toBe(true);
  });

  it("a reconcile-sized id list is answered from the same walk, filtered to those ids", async () => {
    const shop = fakeShopify(510);
    const ids = shop.variants.slice(0, 300).map((variant) => String(variant.id));

    const result = await shopifyConnector({ fetchImpl: shop.fetchImpl }).fetchInventory(store, ids);

    expect(result.ok && result.value.map((level) => level.externalId).sort()).toEqual([...ids].sort());
    expect(shop.requests).toHaveLength(3);
  });

  it("order time: a few variant ids cost one request each, a zero-stock variant answers 0, oversold clamps to 0", async () => {
    const shop = fakeShopify(600, (id) => (id === 50_001 ? 0 : id === 50_002 ? -3 : 5));

    const result = await shopifyConnector({ fetchImpl: shop.fetchImpl }).fetchInventory(store, ["50000", "50001", "50002"]);

    expect(result).toEqual({ ok: true, value: [
      { externalId: "50000", available: 5 },
      { externalId: "50001", available: 0 },
      { externalId: "50002", available: 0 },
    ] });
    expect(shop.requests).toHaveLength(3);
    expect(shop.requests.every((request) => /\/variants\/\d+\.json$/.test(request))).toBe(true);
  });

  it("order time: a variant Shopify no longer has is omitted (the caller refuses the line), not an error", async () => {
    const shop = fakeShopify(5);

    const result = await shopifyConnector({ fetchImpl: shop.fetchImpl }).fetchInventory(store, ["50000", "99999"]);

    expect(result).toEqual({ ok: true, value: [{ externalId: "50000", available: 50_000 % 7 }] });
  });

  it("an API failure is an error, not an empty inventory", async () => {
    const connector = shopifyConnector({ fetchImpl: async () => new Response("", { status: 500 }) });

    expect((await connector.fetchInventory(store)).ok).toBe(false);
    expect((await connector.fetchInventory(store, ["50000"])).ok).toBe(false);
  });

  it("fetchInventoryPage: one request per page, levels keyed by variant id, and a cursor to the next page", async () => {
    const shop = fakeShopify(510);
    const connector = shopifyConnector({ fetchImpl: shop.fetchImpl });
    if (!connector.fetchInventoryPage) throw new Error("the Shopify adapter pages its inventory");

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await connector.fetchInventoryPage(store, cursor);
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      seen.push(...page.value.levels.map((level) => level.externalId));
      cursor = page.value.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(shop.requests).toHaveLength(3);
    expect(new Set(seen)).toEqual(new Set(shop.variants.map((variant) => String(variant.id))));
    expect(seen).toHaveLength(510);
  });
});
