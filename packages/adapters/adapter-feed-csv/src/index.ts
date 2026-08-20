import { defineChannelConnector, Err, Ok } from "@porulle/core";
import type {
  ChannelCatalogPage,
  ChannelConnector,
  ChannelConnectorError,
  ChannelInventoryLevel,
  ChannelOrderSlice,
  ChannelOrderStatus,
  ChannelPushCatalogField,
  ChannelPushCatalogImage,
  ChannelPushCatalogItem,
  ChannelPushCatalogResult,
  ChannelRefundResult,
  ChannelStore,
  ChannelWebhookEvent,
  Result,
  StorageAdapter,
} from "@porulle/core";

export const MERCHANT_CENTER_COLUMNS = [
  "id",
  "title",
  "description",
  "link",
  "image_link",
  "additional_image_link",
  "availability",
  "price",
  "brand",
  "gtin",
  "mpn",
  "condition",
  "product_type",
  "google_product_category",
] as const;

export type MerchantCenterColumn = (typeof MERCHANT_CENTER_COLUMNS)[number];
export type CatalogFieldTarget = "native" | "attribute" | "meta";

export interface CatalogFieldMappingRow {
  fieldPath: string;
  provider?: string;
  target: CatalogFieldTarget;
  remoteKey: string;
}

export type CatalogFieldMapping = CatalogFieldMappingRow[];
export type CatalogFieldMappingInput = CatalogFieldMapping | Record<string, Omit<CatalogFieldMappingRow, "fieldPath">>;

export interface FeedCsvAdapterOptions {
  storage: StorageAdapter;
  publicBaseUrl: string;
  columns?: CatalogFieldMappingInput;
}

export interface FeedCsvPushCatalogResult extends ChannelPushCatalogResult {
  key: string;
  url: string;
}

export interface FeedCsvConnector extends ChannelConnector {
  feedUrl(store: Pick<ChannelStore, "id">): string;
  getFeedUrl(store: Pick<ChannelStore, "id">): string;
  pushCatalog(
    store: ChannelStore,
    items: ChannelPushCatalogItem[],
    opts?: { dryRun?: boolean },
  ): Promise<Result<FeedCsvPushCatalogResult, ChannelConnectorError>>;
}

interface FieldEntry {
  fieldPath: string;
  remoteKey?: string;
  locale?: string;
  value: unknown;
}

interface FeedRowContext {
  item: ChannelPushCatalogItem;
  variant?: NonNullable<ChannelPushCatalogItem["variants"]>[number];
  fields: FieldEntry[];
  images: ChannelPushCatalogImage[];
  store: ChannelStore;
}

const defaultColumns: CatalogFieldMapping = [
  { fieldPath: "attributes.*.title", target: "native", remoteKey: "title" },
  { fieldPath: "attributes.*.description", target: "native", remoteKey: "description" },
  { fieldPath: "entity.link", target: "native", remoteKey: "link" },
  { fieldPath: "media.primary", target: "native", remoteKey: "image_link" },
  { fieldPath: "media.gallery", target: "native", remoteKey: "additional_image_link" },
  { fieldPath: "variants.*.availability", target: "native", remoteKey: "availability" },
  { fieldPath: "variants.*.price", target: "native", remoteKey: "price" },
  { fieldPath: "entity.brand", target: "native", remoteKey: "brand" },
  { fieldPath: "variants.*.barcode", target: "native", remoteKey: "gtin" },
  { fieldPath: "variants.*.sku", target: "native", remoteKey: "mpn" },
  { fieldPath: "entity.condition", target: "native", remoteKey: "condition" },
  { fieldPath: "entity.productType", target: "native", remoteKey: "product_type" },
  { fieldPath: "entity.googleProductCategory", target: "native", remoteKey: "google_product_category" },
];

function normalizeColumns(input: CatalogFieldMappingInput | undefined): CatalogFieldMapping {
  if (!input) return defaultColumns;
  if (Array.isArray(input)) return input;
  return Object.entries(input).map(([fieldPath, value]) => ({ ...value, fieldPath }));
}

function fieldLocale(field: ChannelPushCatalogField): string | undefined {
  if (field.locale) return field.locale;
  const segments = field.fieldPath.split(".");
  return segments[0] === "attributes" ? segments[1] : undefined;
}

function fieldEntries(fields: ChannelPushCatalogField[]): FieldEntry[] {
  return fields.map((field) => {
    const locale = fieldLocale(field);
    return {
      fieldPath: field.fieldPath,
      ...(field.remoteKey !== undefined ? { remoteKey: field.remoteKey } : {}),
      ...(locale !== undefined ? { locale } : {}),
      value: field.value,
    };
  });
}

function matches(pattern: string, path: string): boolean {
  const patternSegments = pattern.split(".");
  const pathSegments = path.split(".");
  return patternSegments.length === pathSegments.length
    && patternSegments.every((segment, index) => segment === "*" || segment === pathSegments[index]);
}

function variantPaths(path: string, variantExternalId: string | undefined): string[] {
  if (!variantExternalId) return [path];
  if (path.startsWith("variants.")) {
    return [path, path.replace(/^variants\./, `variants.${variantExternalId}.`)];
  }
  return [path, `variants.${variantExternalId}.${path}`, `variants.${path}`];
}

function mappedEntries(context: FeedRowContext, column: MerchantCenterColumn, mappings: CatalogFieldMapping): FieldEntry[] {
  const candidates = mappings.filter((mapping) => mapping.remoteKey === column);
  const entries = context.fields;
  const matching = candidates.flatMap((mapping) => entries.filter((entry) => variantPaths(entry.fieldPath, context.variant?.externalId).some((path) => matches(mapping.fieldPath, path))));
  if (matching.length > 0) return matching;
  return entries.filter((entry) => entry.remoteKey === column);
}

function chooseEntry(entries: FieldEntry[], exactLocale?: string): unknown {
  if (entries.length === 0) return undefined;
  if (exactLocale) return entries.find((entry) => entry.locale === exactLocale)?.value;
  return (entries.find((entry) => entry.locale === "en") ?? entries[0])?.value;
}

function resolveValue(context: FeedRowContext, column: MerchantCenterColumn, mappings: CatalogFieldMapping, aliases: string[] = []): unknown {
  const mapped = chooseEntry(mappedEntries(context, column, mappings));
  if (mapped !== undefined) return mapped;
  for (const alias of aliases) {
    const value = chooseEntry(context.fields.filter((entry) => variantPaths(entry.fieldPath, context.variant?.externalId).some((path) => path === alias || path.endsWith(`.${alias}`))));
    if (value !== undefined) return value;
  }
  return undefined;
}

function imageValues(context: FeedRowContext): { image_link?: string; additional_image_link?: string } {
  const images = context.images
    .filter((image) => !image.variantExternalIds || image.variantExternalIds.includes(context.variant?.externalId ?? ""))
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
  const primary = images.find((image) => image.role === "primary") ?? images[0];
  const additional = images.filter((image) => image !== primary && image.role !== "video" && image.role !== "document").map((image) => image.url);
  return {
    ...(primary ? { image_link: primary.url } : {}),
    ...(additional.length > 0 ? { additional_image_link: additional.join(",") } : {}),
  };
}

function formatPrice(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return value == null ? "" : String(value);
  const price = candidate as { amount?: unknown; currency?: unknown };
  if (typeof price.amount !== "number" || typeof price.currency !== "string") return String(value);
  return `${(price.amount / 100).toFixed(2)} ${price.currency.toUpperCase()}`;
}

function formatAvailability(value: unknown): string {
  if (typeof value === "number") return value > 0 ? "in stock" : "out of stock";
  if (value && typeof value === "object" && typeof (value as { available?: unknown }).available === "number") {
    return (value as { available: number }).available > 0 ? "in stock" : "out of stock";
  }
  return value == null ? "" : String(value);
}

function cellValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((entry) => cellValue(entry)).join(",");
  if (typeof value === "object") {
    const candidate = value as { url?: unknown };
    return typeof candidate.url === "string" ? candidate.url : JSON.stringify(value);
  }
  return String(value);
}

function productLink(context: FeedRowContext, mappings: CatalogFieldMapping): string {
  const direct = resolveValue(context, "link", mappings, ["entity.link", "link", "entity.url", "url"]);
  if (direct !== undefined) return cellValue(direct);
  const slug = resolveValue(context, "link", mappings, ["entity.slug", "slug"]);
  if (typeof slug !== "string" || slug.length === 0) return "";
  if (/^https?:\/\//i.test(slug)) return slug;
  return `https://${context.store.storeDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/products/${encodeURIComponent(slug)}`;
}

function renderRow(context: FeedRowContext, mappings: CatalogFieldMapping): string[] {
  const images = imageValues(context);
  const title = resolveValue(context, "title", mappings, ["attributes.title", "title"]);
  const description = resolveValue(context, "description", mappings, ["attributes.description", "description"]);
  const availability = resolveValue(context, "availability", mappings, ["variants.availability", "availability", "inventory.available"]);
  const price = resolveValue(context, "price", mappings, ["variants.price", "price", "prices"]);
  const brand = resolveValue(context, "brand", mappings, ["entity.brand", "brand"]);
  const gtin = resolveValue(context, "gtin", mappings, ["variants.barcode", "barcode", "gtin"]);
  const mpn = resolveValue(context, "mpn", mappings, ["variants.sku", "sku", "mpn"]);
  const condition = resolveValue(context, "condition", mappings, ["entity.condition", "condition"]);
  const productType = resolveValue(context, "product_type", mappings, ["entity.productType", "product_type", "productType", "entity.category", "category"]);
  const googleProductCategory = resolveValue(context, "google_product_category", mappings, ["entity.googleProductCategory", "google_product_category", "googleProductCategory"]);
  const values: Record<MerchantCenterColumn, string> = {
    id: context.variant?.externalId ?? context.item.externalId,
    title: cellValue(title),
    description: cellValue(description),
    link: productLink(context, mappings),
    image_link: images.image_link ?? cellValue(resolveValue(context, "image_link", mappings, ["media.primary", "image_link"])),
    additional_image_link: images.additional_image_link ?? cellValue(resolveValue(context, "additional_image_link", mappings, ["media.gallery", "additional_image_link"])),
    availability: formatAvailability(availability),
    price: formatPrice(price),
    brand: cellValue(brand),
    gtin: cellValue(gtin),
    mpn: cellValue(mpn),
    condition: cellValue(condition) || "new",
    product_type: cellValue(productType),
    google_product_category: cellValue(googleProductCategory),
  };
  return MERCHANT_CENTER_COLUMNS.map((column) => values[column]);
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function renderCsv(store: ChannelStore, items: ChannelPushCatalogItem[], mappings: CatalogFieldMapping): string {
  const rows = [MERCHANT_CENTER_COLUMNS.map(csvCell).join(",")];
  for (const item of items) {
    const variants = item.variants?.length ? item.variants : [undefined];
    for (const variant of variants) {
      const fields = [...fieldEntries(item.fields), ...(variant ? fieldEntries(variant.fields) : [])];
      rows.push(renderRow({
        item,
        ...(variant ? { variant } : {}),
        fields,
        images: item.images ?? [],
        store,
      }, mappings).map(csvCell).join(","));
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}

function feedKey(store: Pick<ChannelStore, "id">): string {
  return `feeds/${encodeURIComponent(store.id)}.csv`;
}

function publicUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${key}`;
}

function notSupported<T>(operation: string): Result<T, ChannelConnectorError> {
  return Err({ code: "NOT_SUPPORTED", message: `CSV feed connector does not support ${operation}.`, retriable: false });
}

export function feedCsvAdapter(options: FeedCsvAdapterOptions): FeedCsvConnector {
  const mappings = normalizeColumns(options.columns);
  const connector = defineChannelConnector({
    providerId: "feed-csv",
    capabilities: {
      importCatalog: false,
      importInventory: false,
      pushOrder: false,
      receiveWebhooks: false,
      pushCatalog: true,
    },
    feedUrl(store: Pick<ChannelStore, "id">): string {
      return publicUrl(options.publicBaseUrl, feedKey(store));
    },
    getFeedUrl(store: Pick<ChannelStore, "id">): string {
      return publicUrl(options.publicBaseUrl, feedKey(store));
    },
    async importCatalog(): Promise<Result<ChannelCatalogPage, ChannelConnectorError>> {
      return notSupported("catalog import");
    },
    async fetchInventory(): Promise<Result<ChannelInventoryLevel[], ChannelConnectorError>> {
      return notSupported("inventory import");
    },
    async pushOrder(): Promise<Result<never, ChannelConnectorError>> {
      return notSupported("order push");
    },
    async pushCatalog(store: ChannelStore, items: ChannelPushCatalogItem[], opts?: { dryRun?: boolean }): Promise<Result<FeedCsvPushCatalogResult, ChannelConnectorError>> {
      const key = feedKey(store);
      const url = publicUrl(options.publicBaseUrl, key);
      let csv: string;
      try {
        csv = renderCsv(store, items, mappings);
      } catch (error) {
        return Err({ code: "FEED_RENDER_FAILED", message: error instanceof Error ? error.message : "Failed to render CSV feed.", retriable: false });
      }
      if (opts?.dryRun === true) {
        return Ok({ key, url, outcomes: items.map((item) => ({ externalId: item.externalId, ok: true })) });
      }
      let body: ArrayBuffer;
      try {
        body = await new Response(csv).arrayBuffer();
      } catch (error) {
        return Err({ code: "FEED_RENDER_FAILED", message: error instanceof Error ? error.message : "Failed to encode CSV feed.", retriable: false });
      }
      const uploaded = await options.storage.upload(key, body, "text/csv; charset=utf-8");
      if (!uploaded.ok) {
        return Err({ code: "FEED_UPLOAD_FAILED", message: uploaded.error.message, retriable: true });
      }
      return Ok({ key, url, outcomes: items.map((item) => ({ externalId: item.externalId, ok: true })) });
    },
    async fetchOrderStatus(): Promise<Result<ChannelOrderStatus, ChannelConnectorError>> {
      return notSupported("order status reads");
    },
    async verifyWebhook(): Promise<Result<ChannelWebhookEvent, ChannelConnectorError>> {
      return notSupported("webhooks");
    },
    async refundExecute(): Promise<Result<ChannelRefundResult, ChannelConnectorError>> {
      return notSupported("refund execution");
    },
  });
  return connector as FeedCsvConnector;
}
