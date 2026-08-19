import { describe, expect, it } from "vitest";
import type { ChannelStore } from "@porulle/core";
import { mockChannelConnector } from "../src/index.js";

const store: ChannelStore = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "org_channel_catalog_shape",
  provider: "mock",
  credentials: {},
  storeDomain: "shape.mock.channel.test",
  status: "connected",
  webhookSecret: null,
};

describe("mock channel catalog shape", () => {
  it("emits the complete PIM catalog shape", async () => {
    const result = await mockChannelConnector().importCatalog(store);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const item = result.value.items[0];
    expect(item).toMatchObject({
      attributes: [{
        locale: "en",
        title: "Mock Channel Product",
        subtitle: "A complete mock catalog item",
        description: "Imported through the mock connector.",
        richDescription: { blocks: [{ type: "paragraph", text: "Mock product details." }] },
        seoTitle: "Mock Channel Product | Porulle",
        seoDescription: "A mock product with the complete channel catalog shape.",
      }],
      images: [{
        externalId: "mock-image-primary",
        url: "https://mock.channel.test/images/mock-product-1-primary.jpg",
        alt: "Mock Channel Product",
        role: "primary",
        sortOrder: 0,
      }, {
        externalId: "mock-image-variant",
        url: "https://mock.channel.test/images/mock-variant-1.jpg",
        alt: "Mock Channel Product blue variant",
        role: "gallery",
        sortOrder: 1,
        variantExternalIds: ["mock-variant-1"],
      }],
      options: [{
        name: "color",
        displayName: "Color",
        sortOrder: 0,
        values: [{ value: "blue", displayValue: "Blue", sortOrder: 0 }],
      }],
      tags: ["mock", "featured"],
      brand: "Porulle",
      categories: ["mock-products"],
      status: "active",
      variants: [{
        externalId: "mock-variant-1",
        sku: "MOCK-SKU-1",
        barcode: "0123456789012",
        optionValues: { color: "blue" },
        prices: [{ currency: "USD", amount: 2500 }],
      }],
    });
  });
});
