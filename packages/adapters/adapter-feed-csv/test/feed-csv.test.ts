import { describe, expect, it } from "vitest";
import type {
  ChannelPushCatalogField,
  ChannelPushCatalogItem,
  ChannelStore,
  StorageAdapter,
} from "@porulle/core";
import { feedCsvAdapter, MERCHANT_CENTER_COLUMNS } from "../src/index.js";

const store: ChannelStore = {
  id: "store-1",
  organizationId: "org-1",
  provider: "feed-csv",
  credentials: {},
  storeDomain: "shop.example",
  status: "connected",
  webhookSecret: null,
};

function memoryStorage() {
  const files = new Map<string, { body: ArrayBuffer; contentType: string }>();
  let uploads = 0;
  const storage: StorageAdapter = {
    providerId: "memory",
    async upload(key, data, contentType) {
      uploads += 1;
      const body = data instanceof ArrayBuffer ? data : await new Response(data).arrayBuffer();
      files.set(key, { body, contentType });
      return { ok: true, value: { key, url: `memory://${key}`, contentType, size: body.byteLength } };
    },
    async getUrl(key) {
      return { ok: true, value: `memory://${key}` };
    },
    async getSignedUrl(key) {
      return { ok: true, value: `memory://${key}` };
    },
    async delete(key) {
      files.delete(key);
      return { ok: true, value: undefined };
    },
    async list(prefix) {
      return {
        ok: true,
        value: [...files.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({
          key,
          url: `memory://${key}`,
          contentType: files.get(key)?.contentType ?? "application/octet-stream",
        })),
      };
    },
  };
  return {
    storage,
    get(key: string): string {
      const file = files.get(key);
      if (!file) throw new Error(`Missing file ${key}`);
      return new TextDecoder().decode(file.body);
    },
    uploads(): number {
      return uploads;
    },
  };
}

function field(fieldPath: string, value: unknown, locale?: string): ChannelPushCatalogField {
  return {
    fieldPath,
    intent: "display",
    value,
    ...(locale ? { locale } : {}),
  };
}

const catalogItem: ChannelPushCatalogItem = {
  externalId: "product-1",
  fields: [
    field("attributes.en.title", 'Rain, "proof" Jacket\nEdition', "en"),
    field("attributes.en.description", "A waterproof, breathable jacket.", "en"),
    field("attributes.si.title", "වැසි ජැකට්", "si"),
    field("attributes.si.description", "වැසි සඳහා ජැකට්.", "si"),
    field("entity.link", "https://shop.example/products/rain-jacket"),
    field("entity.brand", "Summit Supply"),
    field("entity.productType", "Outerwear"),
    field("entity.googleProductCategory", "Apparel & Accessories > Clothing"),
    field("entity.condition", "new"),
  ],
  images: [
    { url: "https://cdn.example/rain-jacket.jpg", role: "primary", sortOrder: 0 },
    { url: "https://cdn.example/rain-jacket-side.jpg", role: "gallery", sortOrder: 1 },
  ],
  variants: [
    {
      externalId: "variant-red-m",
      fields: [
        field("variants.sku", "RJ-RED-M"),
        field("variants.barcode", "0123456789012"),
        field("variants.availability", "in stock"),
        field("variants.price", { amount: 12999, currency: "USD" }),
      ],
    },
    {
      externalId: "variant-blue-l",
      fields: [
        field("variants.sku", "RJ-BLU-L"),
        field("variants.barcode", "0123456789029"),
        field("variants.availability", "in stock"),
        field("variants.price", { amount: 13999, currency: "USD" }),
      ],
    },
  ],
};

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\r" && input[index + 1] === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      index += 1;
    } else {
      value += character;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

describe("feed csv connector", () => {
  it("renders one Merchant Center row per variant and round-trips CSV escaping", async () => {
    const memory = memoryStorage();
    const connector = feedCsvAdapter({ storage: memory.storage, publicBaseUrl: "https://feeds.example.com" });
    const result = await connector.pushCatalog(store, [catalogItem]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.url).toBe("https://feeds.example.com/feeds/store-1.csv");
    expect(result.value.key).toBe("feeds/store-1.csv");
    expect(result.value.outcomes).toEqual([
      { externalId: "product-1", ok: true },
    ]);
    expect(memory.uploads()).toBe(1);

    const parsed = parseCsv(memory.get("feeds/store-1.csv"));
    expect(parsed[0]).toEqual([...MERCHANT_CENTER_COLUMNS]);
    expect(parsed).toHaveLength(3);
    const header = parsed[0] ?? [];
    const rows = parsed.slice(1).map((row) => Object.fromEntries(header.map((column, index) => [column, row?.[index] ?? ""])));
    expect(rows.map((row) => row.id)).toEqual(["variant-red-m", "variant-blue-l"]);
    for (const row of rows) {
      for (const column of ["id", "title", "description", "link", "image_link", "additional_image_link", "availability", "price", "brand", "gtin", "mpn", "condition", "product_type", "google_product_category"]) {
        expect(row[column]).toBeTruthy();
      }
    }
    expect(rows[0]?.title).toBe('Rain, "proof" Jacket\nEdition');
    expect(rows[0]?.description).toBe("A waterproof, breathable jacket.");
    expect(rows[0]?.price).toBe("129.99 USD");
  });

  it("uses a per-store catalogFieldMapping-shaped column override", async () => {
    const memory = memoryStorage();
    const connector = feedCsvAdapter({
      storage: memory.storage,
      publicBaseUrl: "https://feeds.example.com/",
      columns: [{ fieldPath: "custom.feedTitle", target: "attribute", remoteKey: "title" }],
    });
    const item: ChannelPushCatalogItem = {
      ...catalogItem,
      fields: [...catalogItem.fields, field("custom.feedTitle", "Mapped title")],
    };
    const result = await connector.pushCatalog(store, [item]);
    expect(result.ok).toBe(true);
    expect(parseCsv(memory.get("feeds/store-1.csv"))[1]?.[1]).toBe("Mapped title");
  });

  it("keeps the previously served feed when rendering fails before upload", async () => {
    const memory = memoryStorage();
    const connector = feedCsvAdapter({ storage: memory.storage, publicBaseUrl: "https://feeds.example.com" });
    const first = await connector.pushCatalog(store, [catalogItem]);
    expect(first.ok).toBe(true);
    const previous = memory.get("feeds/store-1.csv");
    const brokenField = {} as ChannelPushCatalogField;
    Object.defineProperty(brokenField, "fieldPath", { value: "attributes.en.title" });
    Object.defineProperty(brokenField, "intent", { value: "display" });
    Object.defineProperty(brokenField, "value", { get: () => { throw new Error("catalog changed while rendering"); } });

    const second = await connector.pushCatalog(store, [{ externalId: "product-1", fields: [brokenField] }]);
    expect(second).toEqual({
      ok: false,
      error: { code: "FEED_RENDER_FAILED", message: "catalog changed while rendering", retriable: false },
    });
    expect(memory.uploads()).toBe(1);
    expect(memory.get("feeds/store-1.csv")).toBe(previous);
  });
});
