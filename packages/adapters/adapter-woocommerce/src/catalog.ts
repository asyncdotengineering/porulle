import { Err, Ok, toMinorUnits } from "@porulle/core";
import type { ChannelCatalogImage, ChannelCatalogItem, ChannelCatalogPage, ChannelCatalogPrice, ChannelCatalogVariant, ChannelConnectorError, ChannelStoreProfile, Result } from "@porulle/core";
import { z } from "zod";
import type { WooClient } from "./client.js";

const id = z.union([z.number(), z.string()]).transform(String);
const money = z.string().nullish();
const image = z.object({ id, src: z.string(), alt: z.string().nullish() });

export const wooVariationSchema = z.object({
  id,
  sku: z.string().nullish(),
  price: money,
  regular_price: money,
  sale_price: money,
  status: z.string().nullish(),
  attributes: z.array(z.object({ name: z.string(), option: z.string().nullish() })).default([]),
  image: image.nullish(),
  manage_stock: z.union([z.boolean(), z.literal("parent")]).nullish(),
  stock_quantity: z.number().nullish(),
  stock_status: z.string().nullish(),
});
export type WooVariation = z.infer<typeof wooVariationSchema>;

export const wooProductSchema = z.object({
  id,
  name: z.string(),
  slug: z.string().nullish(),
  type: z.string(),
  status: z.string().nullish(),
  description: z.string().nullish(),
  permalink: z.string().nullish(),
  sku: z.string().nullish(),
  price: money,
  regular_price: money,
  sale_price: money,
  images: z.array(image).default([]),
  attributes: z.array(z.object({ name: z.string(), position: z.number().nullish(), variation: z.boolean().nullish(), options: z.array(z.string()).default([]) })).default([]),
  tags: z.array(z.object({ slug: z.string().nullish() })).default([]),
  categories: z.array(z.object({ slug: z.string().nullish() })).default([]),
  /** Core since WooCommerce 9.6; absent on older stores. */
  brands: z.array(z.object({ name: z.string() })).default([]),
  variations: z.array(id).default([]),
  manage_stock: z.boolean().nullish(),
  stock_quantity: z.number().nullish(),
  stock_status: z.string().nullish(),
});
export type WooProduct = z.infer<typeof wooProductSchema>;

/** Products a shopper can buy through us: a grouped product is a list of others; an external one is sold elsewhere. */
export function isPurchasable(product: WooProduct): boolean {
  return product.type === "simple" || product.type === "variable";
}

/** The amount a shopper pays and, when on sale, the price it is reduced from. Missing price → no price. */
function prices(row: { price?: string | null | undefined; regular_price?: string | null | undefined; sale_price?: string | null | undefined }, currency: string | undefined): ChannelCatalogPrice[] | undefined {
  if (!currency) return undefined;
  const sale = toMinorUnits(row.sale_price, currency);
  const regular = toMinorUnits(row.regular_price, currency);
  const amount = sale ?? regular ?? toMinorUnits(row.price, currency);
  if (amount === undefined) return undefined;
  return [{ currency, amount, ...(sale !== undefined && regular !== undefined && regular > sale ? { compareAtAmount: regular } : {}) }];
}

function status(value: string | null | undefined): ChannelCatalogItem["status"] {
  if (value === "publish") return "active";
  if (value === "draft" || value === "pending" || value === "private") return "draft";
  return undefined;
}

/** "pa_color", "Color" and "color" are one attribute; "Blue" and the term slug "blue" one value. */
function attributeKey(value: string): string {
  return value.trim().toLowerCase().replace(/^pa_/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

interface OptionAxis {
  name: string;
  values: string[];
}

/**
 * The option axes a variable product sells along. WooCommerce lets a variation use a global
 * attribute (`pa_color`) by its term SLUG ("blue") while the product lists the term NAME ("Blue") —
 * or does not list that attribute at all (measured on WooCommerce's own sample catalogue). The axes
 * are the product's declared variation attributes plus any its variations use, and each value is
 * spelled as the product spells it where it declares one, so every variant's values are among them.
 */
function optionAxes(product: WooProduct, variations: WooVariation[]): { axes: OptionAxis[]; resolve: (name: string, option: string) => { name: string; value: string } } {
  const axes = new Map<string, OptionAxis>();
  for (const attribute of product.attributes.filter((candidate) => candidate.variation === true)) {
    axes.set(attributeKey(attribute.name), { name: attribute.name, values: [...attribute.options] });
  }
  const resolve = (name: string, option: string): { name: string; value: string } => {
    const key = attributeKey(name);
    let axis = axes.get(key);
    if (!axis) {
      axis = { name: name.replace(/^pa_/, "").replace(/^./, (first) => first.toUpperCase()), values: [] };
      axes.set(key, axis);
    }
    const declared = axis.values.find((value) => attributeKey(value) === attributeKey(option));
    if (declared) return { name: axis.name, value: declared };
    const shown = option.replace(/^./, (first) => first.toUpperCase());
    axis.values.push(shown);
    return { name: axis.name, value: shown };
  };
  for (const row of variations) for (const attribute of row.attributes) if (attribute.option) resolve(attribute.name, attribute.option);
  return { axes: [...axes.values()], resolve };
}

function variant(row: WooVariation, currency: string | undefined, resolve: (name: string, option: string) => { name: string; value: string }): ChannelCatalogVariant {
  const optionValues = Object.fromEntries(row.attributes.flatMap((attribute) => {
    if (!attribute.option) return [];
    const resolved = resolve(attribute.name, attribute.option);
    return [[resolved.name, resolved.value] as const];
  }));
  const rowPrices = prices(row, currency);
  return {
    externalId: row.id,
    ...(row.sku ? { sku: row.sku } : {}),
    ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
    ...(rowPrices ? { prices: rowPrices } : {}),
  };
}

/**
 * One store product as a catalogue item. A simple product is one variant named by the product's own
 * id (only variations carry a price otherwise, so a simple product would import unpriced).
 */
export function catalogItem(product: WooProduct, variations: WooVariation[], currency: string | undefined): ChannelCatalogItem {
  const images: ChannelCatalogImage[] = product.images.map((entry, index) => ({
    externalId: entry.id,
    url: entry.src,
    ...(entry.alt ? { alt: entry.alt } : {}),
    role: index === 0 ? "primary" : "gallery",
    sortOrder: index,
  }));
  const seen = new Set(images.map((entry) => entry.externalId));
  for (const row of variations) {
    if (!row.image || row.image.id === "0") continue;
    const existing = images.find((entry) => entry.externalId === row.image?.id);
    if (existing) {
      existing.variantExternalIds = [...(existing.variantExternalIds ?? []), row.id];
    } else if (!seen.has(row.image.id)) {
      seen.add(row.image.id);
      images.push({ externalId: row.image.id, url: row.image.src, ...(row.image.alt ? { alt: row.image.alt } : {}), role: "gallery", sortOrder: images.length, variantExternalIds: [row.id] });
    }
  }
  const sellable = product.type === "simple" ? [] : variations.filter((row) => row.status !== "private");
  const { axes, resolve } = optionAxes(product, sellable);
  const variants = product.type === "simple"
    ? [variant({ id: product.id, sku: product.sku, price: product.price, regular_price: product.regular_price, sale_price: product.sale_price, attributes: [] }, currency, resolve)]
    : sellable.map((row) => variant(row, currency, resolve));
  const options = product.type === "simple" ? [] : axes.map((axis, index) => ({
    name: axis.name,
    displayName: axis.name,
    sortOrder: index,
    values: axis.values.map((value, valueIndex) => ({ value, displayValue: value, sortOrder: valueIndex })),
  }));
  const itemStatus = status(product.status);
  return {
    externalId: product.id,
    slug: product.slug || product.id,
    title: product.name,
    ...(product.description ? { description: product.description } : {}),
    attributes: [{ locale: "en", title: product.name, ...(product.description ? { description: product.description } : {}) }],
    variants,
    ...(images.length > 0 ? { images } : {}),
    ...(options.length > 0 ? { options } : {}),
    tags: product.tags.flatMap((tag) => (tag.slug ? [tag.slug] : [])),
    categories: product.categories.flatMap((category) => (category.slug ? [category.slug] : [])),
    ...(product.brands[0] ? { brand: product.brands[0].name } : {}),
    ...(itemStatus ? { status: itemStatus } : {}),
    ...(product.permalink ? { storefrontUrl: product.permalink } : {}),
  };
}

/** Every variation of a variable product, whatever changed: a changed product is re-read whole. */
export async function variationsOf(client: WooClient, product: WooProduct): Promise<Result<WooVariation[], ChannelConnectorError>> {
  if (product.type !== "variable" || product.variations.length === 0) return Ok([]);
  return client.all(`/wc/v3/products/${encodeURIComponent(product.id)}/variations`, wooVariationSchema);
}

/**
 * The import cursor, as JSON: `{ page, after? }`. `after` is the `date_modified_gmt` an incremental
 * import resumes from; pages are walked oldest change first so a resumed walk never skips one.
 */
const cursorSchema = z.object({ page: z.number().int().positive(), after: z.string().optional() });

export async function importPage(client: WooClient, cursor: string | undefined): Promise<Result<ChannelCatalogPage, ChannelConnectorError>> {
  let position: z.infer<typeof cursorSchema> = { page: 1 };
  if (cursor) {
    let raw: unknown;
    try {
      raw = JSON.parse(cursor);
    } catch {
      raw = undefined;
    }
    const parsed = cursorSchema.safeParse(raw);
    // Anything else is an ISO time: "everything changed since".
    position = parsed.success ? parsed.data : { page: 1, after: cursor };
  }
  const query: Record<string, string> = { per_page: "50", page: String(position.page), orderby: "modified", order: "asc" };
  if (position.after) {
    query.modified_after = position.after;
    query.dates_are_gmt = "true";
  }
  const read = await client.get("/wc/v3/products", z.array(wooProductSchema), query);
  if (!read.ok) return read;
  const items: ChannelCatalogItem[] = [];
  for (const product of read.value.data) {
    if (!isPurchasable(product)) continue;
    const variations = await variationsOf(client, product);
    if (!variations.ok) return variations;
    items.push(catalogItem(product, variations.value, client.credentials.currency));
  }
  const nextCursor = position.page < read.value.totalPages ? JSON.stringify({ ...position, page: position.page + 1 }) : null;
  return Ok({ items, nextCursor });
}

/** The named products as they are now; an id the store no longer has, or cannot sell through us, is absent. */
export async function catalogItems(client: WooClient, externalIds: string[]): Promise<Result<ChannelCatalogItem[], ChannelConnectorError>> {
  const items: ChannelCatalogItem[] = [];
  for (let offset = 0; offset < externalIds.length; offset += 100) {
    const ids = externalIds.slice(offset, offset + 100);
    const read = await client.get("/wc/v3/products", z.array(wooProductSchema), { include: ids.join(","), per_page: "100", status: "any" });
    if (!read.ok) return read;
    for (const product of read.value.data) {
      if (!isPurchasable(product)) continue;
      const variations = await variationsOf(client, product);
      if (!variations.ok) return variations;
      items.push(catalogItem(product, variations.value, client.credentials.currency));
    }
  }
  return Ok(items);
}

const rootSchema = z.object({ name: z.string() });

export async function storeProfile(client: WooClient): Promise<Result<ChannelStoreProfile, ChannelConnectorError>> {
  const root = await client.get("/", rootSchema);
  if (!root.ok) return root;
  const currency = client.credentials.currency;
  if (!currency) return Err({ code: "WOO_STORE_NOT_DISCOVERED", message: "The store's currency is not known yet.", retriable: true });
  return Ok({ name: root.value.data.name, currency, storefrontHosts: [new URL(client.base).host] });
}
