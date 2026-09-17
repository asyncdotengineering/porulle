import { describe, expect, it } from "vitest";
import { shopifyConnector } from "../src/index.js";

/**
 * Shopify returns `grams` on every REST variant; the adapter's internal type
 * did not declare it, so `importCatalog` discarded it and every imported
 * product arrived weightless. The mapped key is `variant.metadata.weightGrams`,
 * which is what core's `resolveWeightGrams` reads.
 *
 * The key is OMITTED when the weight is unknown — never written as `0`, because
 * `0` is indistinguishable from a genuinely weightless item and would defeat the
 * consuming card's substitution rule.
 */

const store = {
  id: "store-1",
  organizationId: "org-1",
  provider: "shopify",
  credentials: { accessToken: "token" },
  storeDomain: "shop.example",
  status: "connected" as const,
  webhookSecret: "webhook-secret",
};

type ShopifyVariantFixture = Record<string, unknown>;

function productWithVariants(
  variants: ShopifyVariantFixture[],
): Record<string, unknown> {
  return {
    id: 501,
    title: "Weighted Product",
    handle: "weighted-product",
    status: "active",
    variants,
  };
}

/** The mapped `metadata.weightGrams` per variant, `undefined` when omitted. */
async function importedWeights(
  variants: ShopifyVariantFixture[],
): Promise<Array<number | undefined>> {
  const connector = shopifyConnector({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/shop.json")) {
        return new Response(JSON.stringify({ shop: { currency: "USD" } }));
      }
      return new Response(
        JSON.stringify({ products: [productWithVariants(variants)] }),
      );
    },
  });

  const result = await connector.importCatalog(store);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("importCatalog failed");
  const item = result.value.items[0];
  expect(item).toBeDefined();
  if (item === undefined) throw new Error("no imported item");

  return (item.variants ?? []).map((variant) => {
    const metadata = variant.metadata as Record<string, unknown> | undefined;
    if (metadata === undefined) return undefined;
    if (!Object.hasOwn(metadata, "weightGrams")) return undefined;
    const value = metadata.weightGrams;
    return typeof value === "number" ? value : undefined;
  });
}

/** True when the variant carries no `weightGrams` key at all. */
async function weightKeyIsAbsent(
  variant: ShopifyVariantFixture,
): Promise<boolean> {
  const connector = shopifyConnector({
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/shop.json")) {
        return new Response(JSON.stringify({ shop: { currency: "USD" } }));
      }
      return new Response(
        JSON.stringify({ products: [productWithVariants([variant])] }),
      );
    },
  });
  const result = await connector.importCatalog(store);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("importCatalog failed");
  const mapped = result.value.items[0]?.variants?.[0];
  expect(mapped).toBeDefined();
  const metadata = mapped?.metadata as Record<string, unknown> | undefined;
  return metadata === undefined || !Object.hasOwn(metadata, "weightGrams");
}

describe("shopify variant weight carries through importCatalog", () => {
  it("G1: grams is carried straight through", async () => {
    expect(await importedWeights([{ id: 1, grams: 250 }])).toEqual([250]);
  });

  it("G2: weight is normalised by weight_unit when grams is zero", async () => {
    // A grams-only fixture proves nothing about conversion.
    expect(
      await importedWeights([
        { id: 1, grams: 0, weight: 1.2, weight_unit: "kg" },
      ]),
    ).toEqual([1200]);
  });

  it("G3: grams wins over weight when both are present", async () => {
    // Without this the precedence is untested and either order passes.
    expect(
      await importedWeights([
        { id: 1, grams: 250, weight: 9, weight_unit: "kg" },
      ]),
    ).toEqual([250]);
  });

  it("G4: a non-metric unit converts and rounds", async () => {
    // 8 oz * 28.349523125 = 226.796… -> 227
    expect(
      await importedWeights([{ id: 1, weight: 8, weight_unit: "oz" }]),
    ).toEqual([227]);
  });

  it("G5: an unknown unit is not assumed, while a known one still converts", async () => {
    expect(
      await weightKeyIsAbsent({ id: 1, weight: 2, weight_unit: "stones" }),
    ).toBe(true);

    // The twin: the same shape with a unit the adapter knows must convert, so
    // the absence above is a refusal rather than a mapper that never writes.
    // 2 lb * 453.59237 = 907.18… -> 907
    expect(
      await importedWeights([{ id: 1, weight: 2, weight_unit: "lb" }]),
    ).toEqual([907]);
  });

  it("G6: neither field present leaves the key absent, not zero", async () => {
    // The distinction the consuming card's substitution rule depends on. A row
    // asserting `=== 0` would encode the defect instead of catching it.
    expect(await weightKeyIsAbsent({ id: 1, sku: "NO-WEIGHT" })).toBe(true);
  });

  it("G6b: a zero-only weight is absent, and a positive one is present", async () => {
    expect(await weightKeyIsAbsent({ id: 1, grams: 0 })).toBe(true);
    expect(await importedWeights([{ id: 1, grams: 1 }])).toEqual([1]);
  });

  it("G1b: variants are mapped independently within one product", async () => {
    expect(
      await importedWeights([
        { id: 1, grams: 250 },
        { id: 2, sku: "NO-WEIGHT" },
        { id: 3, weight: 1, weight_unit: "kg" },
      ]),
    ).toEqual([250, undefined, 1000]);
  });
});
