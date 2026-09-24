import { z } from "zod";
import type {
  ChannelCatalogImage,
  ChannelCatalogItem,
  ChannelCatalogLocalizedAttributes,
  ChannelCatalogOptionType,
  ChannelCatalogPrice,
  ChannelCatalogVariant,
  ChannelInventoryLevel,
} from "./adapter.js";

/**
 * The parser for a catalog item that crossed a trust boundary — a queue message, an R2 object, a
 * JSON fixture. Import this rather than re-declaring a subset: a consumer's hand-written schema that
 * kept only the fields it knew about once converged 96 products with no options, prices or
 * inventory, and a reconcile then "re-converged" all of them. The `Equals` checks at the bottom make
 * this schema fail to compile the day it and the interfaces disagree.
 */
const record = z.record(z.string(), z.unknown());

export const channelCatalogLocalizedAttributesSchema = z.object({
  locale: z.string(),
  title: z.string(),
  subtitle: z.string().exactOptional(),
  description: z.string().exactOptional(),
  richDescription: z.unknown().exactOptional(),
  seoTitle: z.string().exactOptional(),
  seoDescription: z.string().exactOptional(),
});

export const channelCatalogImageSchema = z.object({
  externalId: z.string().exactOptional(),
  url: z.string(),
  alt: z.string().exactOptional(),
  role: z.enum(["primary", "gallery", "thumbnail", "video", "document"]),
  sortOrder: z.number().exactOptional(),
  variantExternalIds: z.array(z.string()).exactOptional(),
});

export const channelCatalogOptionTypeSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  sortOrder: z.number().exactOptional(),
  values: z.array(z.object({
    value: z.string(),
    displayValue: z.string(),
    sortOrder: z.number().exactOptional(),
  })),
});

export const channelCatalogPriceSchema = z.object({
  currency: z.string(),
  amount: z.number(),
  compareAtAmount: z.number().exactOptional(),
});

export const channelCatalogVariantSchema = z.object({
  externalId: z.string(),
  sku: z.string().exactOptional(),
  barcode: z.string().exactOptional(),
  metadata: record.exactOptional(),
  optionValues: z.record(z.string(), z.string()).exactOptional(),
  prices: z.array(channelCatalogPriceSchema).exactOptional(),
});

export const channelCatalogItemSchema = z.object({
  externalId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().exactOptional(),
  variants: z.array(channelCatalogVariantSchema),
  metadata: record.exactOptional(),
  attributes: z.array(channelCatalogLocalizedAttributesSchema).exactOptional(),
  images: z.array(channelCatalogImageSchema).exactOptional(),
  options: z.array(channelCatalogOptionTypeSchema).exactOptional(),
  tags: z.array(z.string()).exactOptional(),
  brand: z.string().exactOptional(),
  categories: z.array(z.string()).exactOptional(),
  status: z.enum(["draft", "active", "archived", "discontinued"]).exactOptional(),
});

export const channelInventoryLevelSchema = z.object({
  externalId: z.string(),
  available: z.number(),
});

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type ChannelCatalogSchemaChecks = [
  Assert<Equals<z.infer<typeof channelCatalogLocalizedAttributesSchema>, ChannelCatalogLocalizedAttributes>>,
  Assert<Equals<z.infer<typeof channelCatalogImageSchema>, ChannelCatalogImage>>,
  Assert<Equals<z.infer<typeof channelCatalogOptionTypeSchema>, ChannelCatalogOptionType>>,
  Assert<Equals<z.infer<typeof channelCatalogPriceSchema>, ChannelCatalogPrice>>,
  Assert<Equals<z.infer<typeof channelCatalogVariantSchema>, ChannelCatalogVariant>>,
  Assert<Equals<z.infer<typeof channelCatalogItemSchema>, ChannelCatalogItem>>,
  Assert<Equals<z.infer<typeof channelInventoryLevelSchema>, ChannelInventoryLevel>>,
];
