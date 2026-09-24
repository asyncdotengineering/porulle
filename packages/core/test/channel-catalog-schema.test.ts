import { describe, expect, it } from "vitest";
import type { ChannelCatalogItem } from "../src/index.js";
import { channelCatalogItemSchema, channelInventoryLevelSchema } from "../src/index.js";

// Every field the interface declares, populated. A consumer that re-parses a catalog item through a
// schema of its own once dropped options, prices, attributes and taxonomy; this one must not.
const full: ChannelCatalogItem = {
  externalId: "p-1",
  slug: "pleated-pant",
  title: "Pleated pant",
  description: "Wool.",
  metadata: { source: "fixture" },
  attributes: [{ locale: "en", title: "Pleated pant", subtitle: "s", description: "d", richDescription: { blocks: [] }, seoTitle: "t", seoDescription: "sd" }],
  images: [{ externalId: "i-1", url: "https://cdn.test/1.jpg", alt: "front", role: "primary", sortOrder: 0, variantExternalIds: ["v-1"] }],
  options: [{ name: "size", displayName: "Size", sortOrder: 0, values: [{ value: "m", displayValue: "M", sortOrder: 0 }] }],
  tags: ["wool"],
  brand: "Atelier",
  categories: ["pants"],
  status: "active",
  variants: [{
    externalId: "v-1",
    sku: "PP-M",
    barcode: "0123",
    metadata: { weight: 300 },
    optionValues: { size: "m" },
    prices: [{ currency: "LKR", amount: 1000, compareAtAmount: 1200 }],
  }],
};

describe("channelCatalogItemSchema", () => {
  it("round-trips every field of a fully populated item", () => {
    expect(channelCatalogItemSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });

  it("refuses an item missing what the interface requires", () => {
    expect(channelCatalogItemSchema.safeParse({ externalId: "p-1", slug: "x", variants: [] }).success).toBe(false);
    expect(channelInventoryLevelSchema.safeParse({ externalId: "v-1", available: "3" }).success).toBe(false);
  });
});
