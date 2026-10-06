import { Err, Ok, toMinorUnits } from "@porulle/core";
import type { ChannelCatalogItem, ChannelCatalogPrice, ChannelConnectorError, Result } from "@porulle/core";
import { z } from "zod";
import { shopifyGid, shopifyGraphql } from "./graphql.js";
import type { ShopifyGraphqlTarget } from "./graphql.js";

/**
 * Products per catalogue page. Measured against Shopify's own demo store through its public GraphQL
 * proxy on 2026-10-03: 25 products with 25 variants and 10 media each requested 320 cost points
 * against a 2,000-point bucket restoring 100/s. 50 keeps a page well under the 1,000-point
 * single-query ceiling while halving the number of calls a large catalogue takes.
 */
export const CATALOG_PAGE_PRODUCTS = 50;
/** Variants read with the product; a product with more is completed by `VARIANTS_PAGE`. */
const VARIANTS_WITH_PRODUCT = 25;
/** Images read per product. Import selects a hero and a few gallery images from these. */
const MEDIA_PER_PRODUCT = 20;

const VARIANT_FIELDS = `
  legacyResourceId sku price compareAtPrice inventoryQuantity
  barcodes(first: 1) { nodes { value } }
  selectedOptions { name value }
  media(first: 1) { nodes { id } }
  inventoryItem { legacyResourceId measurement { weight { unit value } } }`;

const PRODUCT_FIELDS = `
  legacyResourceId title handle status descriptionHtml vendor productType tags onlineStoreUrl
  category { id name }
  options { name position optionValues { name } }
  media(first: ${MEDIA_PER_PRODUCT}) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } }
  variants(first: ${VARIANTS_WITH_PRODUCT}) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } }`;

export const CATALOG_PAGE_QUERY = `query PorulleCatalogPage($first: Int!, $after: String) {
  shop { currencyCode }
  products(first: $first, after: $after, sortKey: ID) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } }
}`;

export const VARIANTS_PAGE_QUERY = `query PorulleProductVariants($id: ID!, $after: String) {
  product(id: $id) { variants(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } } }
}`;

export const CATALOG_ITEMS_QUERY = `query PorulleCatalogItems($ids: [ID!]!) {
  shop { currencyCode }
  nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } }
}`;

const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

const variantSchema = z.object({
  legacyResourceId: z.string(),
  sku: z.string().nullable(),
  price: z.string(),
  compareAtPrice: z.string().nullable(),
  inventoryQuantity: z.number().nullable(),
  barcodes: z.object({ nodes: z.array(z.object({ value: z.string() })) }),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  media: z.object({ nodes: z.array(z.object({ id: z.string() })) }),
  inventoryItem: z.object({
    legacyResourceId: z.string(),
    measurement: z.object({ weight: z.object({ unit: z.string(), value: z.number() }).nullable() }),
  }),
});
type ShopifyVariant = z.infer<typeof variantSchema>;

const variantConnectionSchema = z.object({ pageInfo: pageInfoSchema, nodes: z.array(variantSchema) });

const productSchema = z.object({
  legacyResourceId: z.string(),
  title: z.string(),
  handle: z.string(),
  status: z.string(),
  descriptionHtml: z.string(),
  vendor: z.string(),
  productType: z.string(),
  tags: z.array(z.string()),
  onlineStoreUrl: z.string().nullable(),
  category: z.object({ id: z.string(), name: z.string() }).nullable(),
  options: z.array(z.object({ name: z.string(), position: z.number(), optionValues: z.array(z.object({ name: z.string() })) })),
  media: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      alt: z.string().nullable(),
      mediaContentType: z.string(),
      image: z.object({ url: z.string() }).nullable().optional(),
    })),
  }),
  variants: variantConnectionSchema,
});
type ShopifyProduct = z.infer<typeof productSchema>;

const shopCurrencySchema = z.object({ currencyCode: z.string() });

export const catalogPageSchema = z.object({
  shop: shopCurrencySchema,
  products: z.object({ pageInfo: pageInfoSchema, nodes: z.array(productSchema) }),
});

const variantsPageSchema = z.object({ product: z.object({ variants: variantConnectionSchema }).nullable() });

const catalogItemsSchema = z.object({
  shop: shopCurrencySchema,
  // `nodes` answers null for an id that no longer exists, and `{}` for one that is not a Product.
  nodes: z.array(z.union([productSchema, z.object({}).strict(), z.null()])),
});

const GRAMS_PER_UNIT: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };

/**
 * Grams, or undefined — never 0 — when no weight is known, so the caller omits the key. A written
 * 0 is indistinguishable from a weightless item and would defeat a default-parcel substitution. An
 * unknown unit is refused rather than assumed to be grams.
 */
function weightGrams(variant: ShopifyVariant): number | undefined {
  const weight = variant.inventoryItem.measurement.weight;
  if (!weight || !Number.isFinite(weight.value) || weight.value <= 0) return undefined;
  const factor = GRAMS_PER_UNIT[weight.unit];
  return factor === undefined ? undefined : Math.round(weight.value * factor);
}

function prices(variant: ShopifyVariant, currency: string): ChannelCatalogPrice[] | undefined {
  const amount = toMinorUnits(variant.price, currency);
  if (amount === undefined) return undefined;
  const compareAtAmount = variant.compareAtPrice === null ? undefined : toMinorUnits(variant.compareAtPrice, currency);
  return [{ currency, amount, ...(compareAtAmount !== undefined && compareAtAmount !== amount ? { compareAtAmount } : {}) }];
}

/**
 * UNLISTED is live but hidden from the shop's own search and collections — the merchant chose not to
 * surface it, so it is not surfaced here either. Any status this version does not know is a draft:
 * the safe direction for a value that decides whether a product is shown.
 */
function catalogStatus(status: string): "active" | "draft" | "archived" {
  if (status === "ACTIVE") return "active";
  if (status === "ARCHIVED") return "archived";
  return "draft";
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** `gid://shopify/TaxonomyCategory/aa-1-4` → `aa-1-4`, the Standard Product Taxonomy's own id. */
function taxonomyCategoryId(gid: string): string | undefined {
  const id = gid.slice(gid.lastIndexOf("/") + 1);
  return /^[a-z]{2}(-\d+)*$/.test(id) ? id : undefined;
}

export function toCatalogItem(product: ShopifyProduct, variants: readonly ShopifyVariant[], currency: string): ChannelCatalogItem {
  const images = product.media.nodes.flatMap((media) => (media.mediaContentType === "IMAGE" && media.image ? [{ id: media.id, url: media.image.url, alt: media.alt }] : []));
  const category = product.productType ? slugify(product.productType) : product.category ? slugify(product.category.name) : "";
  const storefrontUrl = product.onlineStoreUrl;
  // The merchant's (or Shopify's) Standard Product Taxonomy category, as Shopify's own id. A
  // platform that classifies against the same taxonomy reads it instead of guessing from text.
  const shopifyCategory = product.category ? taxonomyCategoryId(product.category.id) : undefined;
  return {
    externalId: product.legacyResourceId,
    slug: product.handle,
    title: product.title,
    attributes: [{ locale: "en", title: product.title, ...(product.descriptionHtml ? { description: product.descriptionHtml } : {}) }],
    variants: variants.map((variant) => {
      const optionValues = Object.fromEntries(variant.selectedOptions.map((option) => [option.name, option.value] as const));
      const variantPrices = prices(variant, currency);
      const grams = weightGrams(variant);
      const barcode = variant.barcodes.nodes[0]?.value;
      return {
        externalId: variant.legacyResourceId,
        ...(variant.sku ? { sku: variant.sku } : {}),
        ...(barcode ? { barcode } : {}),
        ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
        ...(variantPrices ? { prices: variantPrices } : {}),
        // The inventory item id lets a stock webhook, which names only the item, find this variant.
        metadata: { inventoryItemId: variant.inventoryItem.legacyResourceId, ...(grams !== undefined ? { weightGrams: grams } : {}) },
      };
    }),
    images: images.map((image, index) => ({
      externalId: image.id,
      url: image.url,
      ...(image.alt ? { alt: image.alt } : {}),
      role: index === 0 ? "primary" as const : "gallery" as const,
      sortOrder: index + 1,
      variantExternalIds: variants.filter((variant) => variant.media.nodes.some((media) => media.id === image.id)).map((variant) => variant.legacyResourceId),
    })),
    options: product.options.map((option) => ({
      name: option.name,
      displayName: option.name,
      sortOrder: option.position,
      values: option.optionValues.map((value, index) => ({ value: value.name, displayValue: value.name, sortOrder: index })),
    })),
    tags: product.tags,
    ...(product.vendor ? { brand: product.vendor } : {}),
    ...(category ? { categories: [category] } : {}),
    status: catalogStatus(product.status),
    // Only Shopify's own answer. Null means the product is not on the Online Store channel; a URL
    // assembled from the handle would be a guess that 404s on any shop with a custom route.
    ...(storefrontUrl ? { storefrontUrl } : {}),
    ...(shopifyCategory ? { metadata: { shopifyTaxonomyCategoryId: shopifyCategory } } : {}),
  };
}

/** Every variant of `product`: the ones read with it, then the rest a page at a time. */
async function allVariants(target: ShopifyGraphqlTarget, product: ShopifyProduct): Promise<Result<ShopifyVariant[], ChannelConnectorError>> {
  const variants = [...product.variants.nodes];
  let pageInfo = product.variants.pageInfo;
  const seen = new Set<string>();
  while (pageInfo.hasNextPage && pageInfo.endCursor) {
    if (seen.has(pageInfo.endCursor)) return Err({ code: "SHOPIFY_PAGINATION_STUCK", message: `Shopify repeated a variant page for product ${product.legacyResourceId}.` });
    seen.add(pageInfo.endCursor);
    const page = await shopifyGraphql(target, VARIANTS_PAGE_QUERY, { id: shopifyGid("Product", product.legacyResourceId), after: pageInfo.endCursor }, variantsPageSchema);
    if (!page.ok) return page;
    if (!page.value.product) break;
    variants.push(...page.value.product.variants.nodes);
    pageInfo = page.value.product.variants.pageInfo;
  }
  return Ok(variants);
}

async function toItems(target: ShopifyGraphqlTarget, products: readonly ShopifyProduct[], currency: string): Promise<Result<ChannelCatalogItem[], ChannelConnectorError>> {
  const items: ChannelCatalogItem[] = [];
  for (const product of products) {
    const variants = await allVariants(target, product);
    if (!variants.ok) return variants;
    items.push(toCatalogItem(product, variants.value, currency));
  }
  return Ok(items);
}

export async function readCatalogPage(
  target: ShopifyGraphqlTarget,
  cursor: string | undefined,
): Promise<Result<{ items: ChannelCatalogItem[]; nextCursor: string | null }, ChannelConnectorError>> {
  const page = await shopifyGraphql(target, CATALOG_PAGE_QUERY, { first: CATALOG_PAGE_PRODUCTS, after: cursor ?? null }, catalogPageSchema);
  if (!page.ok) return page;
  const { pageInfo, nodes } = page.value.products;
  if (pageInfo.hasNextPage && (!pageInfo.endCursor || pageInfo.endCursor === cursor)) {
    return Err({ code: "SHOPIFY_PAGINATION_STUCK", message: "Shopify answered a product page that does not advance." });
  }
  const items = await toItems(target, nodes, page.value.shop.currencyCode);
  if (!items.ok) return items;
  return Ok({ items: items.value, nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null });
}

/** The current state of the named products. An id Shopify no longer has is simply absent. */
export async function readCatalogItems(target: ShopifyGraphqlTarget, externalIds: readonly string[]): Promise<Result<ChannelCatalogItem[], ChannelConnectorError>> {
  const items: ChannelCatalogItem[] = [];
  for (let offset = 0; offset < externalIds.length; offset += CATALOG_PAGE_PRODUCTS) {
    const ids = externalIds.slice(offset, offset + CATALOG_PAGE_PRODUCTS).map((id) => shopifyGid("Product", id));
    const page = await shopifyGraphql(target, CATALOG_ITEMS_QUERY, { ids }, catalogItemsSchema);
    if (!page.ok) return page;
    const products = page.value.nodes.filter((node): node is ShopifyProduct => node !== null && "legacyResourceId" in node);
    const converted = await toItems(target, products, page.value.shop.currencyCode);
    if (!converted.ok) return converted;
    items.push(...converted.value);
  }
  return Ok(items);
}
