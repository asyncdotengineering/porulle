/**
 * An imported variant records its Shopify INVENTORY ITEM id. Shopify's `inventory_levels/update`
 * webhook names only the inventory item, whose id differs from the variant id; the connector resolves
 * the variant through `metadata.inventoryItemId`, so an import that drops it leaves every stock
 * webhook unresolvable.
 */
import { describe, expect, it } from "vitest";
import { shopifyConnector } from "../src/index.js";

const store = { id: "store-1", organizationId: "org-1", provider: "shopify", credentials: { accessToken: "token" }, storeDomain: "shop.example", status: "connected" as const, webhookSecret: "webhook-secret" };

const products = [{
  id: 1000,
  title: "Linen shirt",
  handle: "linen-shirt",
  status: "active",
  variants: [
    { id: 50000, inventory_item_id: 900000, sku: "LS-S", price: "25.00", inventory_quantity: 3 },
    { id: 50001, inventory_item_id: 900001, sku: "LS-M", price: "25.00", grams: 300, inventory_quantity: 1 },
  ],
}];

const fetchImpl: typeof fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname.endsWith("/shop.json")) return Response.json({ shop: { currency: "LKR" } });
  if (url.pathname.endsWith("/products.json")) return Response.json({ products });
  return Response.json({});
};

describe("Shopify import", () => {
  it("records each variant's inventory item id in its metadata, beside any weight", async () => {
    const page = await shopifyConnector({ fetchImpl }).importCatalog(store);

    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const variants = page.value.items[0]?.variants ?? [];
    expect(Object.fromEntries(variants.map((variant) => [variant.externalId, variant.metadata?.inventoryItemId]))).toEqual({ "50000": "900000", "50001": "900001" });
    expect(variants.find((variant) => variant.externalId === "50001")?.metadata?.weightGrams).toBe(300);
  });
});
