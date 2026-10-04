import { Err, Ok } from "@porulle/core";
import type {
  ChannelConnectorError,
  ChannelPushCatalogField,
  ChannelPushCatalogItem,
  ChannelPushCatalogResult,
  ChannelPushCatalogVariant,
  ChannelStore,
  Result,
} from "@porulle/core";
import { z } from "zod";
import type { WooClient } from "./client.js";

/** Catalogue writes from the platform into the store: fields, images, filterable attributes and tags. */

const anyId = z.union([z.number(), z.string()]);
const globalAttributeSchema = z.object({ id: anyId, name: z.string(), slug: z.string().nullish() });
type WooGlobalAttribute = z.infer<typeof globalAttributeSchema>;
const termSchema = z.object({ id: anyId, name: z.string() });
type WooTerm = z.infer<typeof termSchema>;
const pushProductSchema = z.object({
  images: z.array(z.object({ id: anyId, src: z.string(), alt: z.string().nullish(), position: z.number().nullish() })).optional(),
  attributes: z.array(z.object({ id: anyId.optional(), name: z.string(), visible: z.boolean().nullish(), variation: z.boolean().nullish(), position: z.number().nullish(), options: z.array(z.string()).optional() })).optional(),
});
type WooProduct = z.infer<typeof pushProductSchema>;
const batchResponseSchema = z.object({ update: z.array(z.object({ id: anyId.optional(), error: z.unknown().optional() })).optional() });

type WooUpdate = Record<string, unknown>;

type WooCatalogPlan = {
  productBody: WooUpdate;
  filterableFields: ChannelPushCatalogField[];
  variants: Array<{ variant: ChannelPushCatalogVariant; body: WooUpdate }>;
};

export interface PushCaches {
  attributeCache: Map<string, Promise<Result<WooGlobalAttribute, ChannelConnectorError>>>;
  termCache: Map<string, Promise<Result<WooTerm, ChannelConnectorError>>>;
}

export function pushCaches(): PushCaches {
  return { attributeCache: new Map(), termCache: new Map() };
}

const PORULLE_META_PREFIX = "porulle_";
const WOO_BATCH_LIMIT = 100;

const wooProductNativeFields = new Set([
  "name",
  "slug",
  "type",
  "status",
  "featured",
  "catalog_visibility",
  "description",
  "short_description",
  "sku",
  "regular_price",
  "sale_price",
  "date_on_sale_from",
  "date_on_sale_to",
  "virtual",
  "downloadable",
  "downloads",
  "download_limit",
  "download_expiry",
  "external_url",
  "button_text",
  "tax_status",
  "tax_class",
  "manage_stock",
  "stock_quantity",
  "backorders",
  "sold_individually",
  "weight",
  "dimensions",
  "shipping_class",
  "reviews_allowed",
  "upsell_ids",
  "cross_sell_ids",
  "parent_id",
  "purchase_note",
  "menu_order",
  "images",
]);

const wooVariationNativeFields = new Set([
  "description",
  "sku",
  "regular_price",
  "sale_price",
  "date_on_sale_from",
  "date_on_sale_to",
  "status",
  "virtual",
  "downloadable",
  "downloads",
  "download_limit",
  "download_expiry",
  "tax_status",
  "tax_class",
  "manage_stock",
  "stock_quantity",
  "backorders",
  "weight",
  "dimensions",
  "shipping_class",
  "shipping_class_id",
  "image",
  "menu_order",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function batchErrorMessage(error: unknown): string {
  const record = asRecord(error);
  return typeof record?.message === "string" && record.message.trim() !== ""
    ? record.message
    : typeof error === "string" && error.trim() !== ""
      ? error
      : "WooCommerce batch update failed.";
}

function batchErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  return typeof data?.status === "number" ? data.status : undefined;
}

function batchItemError(error: unknown): ChannelConnectorError {
  return {
    code: "WOO_API_FAILED",
    message: batchErrorMessage(error),
    retriable: ((status) => status !== undefined && (status >= 500 || status === 408 || status === 429))(batchErrorStatus(error)),
  };
}

function catalogPushError(code: string, message: string): Result<never, ChannelConnectorError> {
  return Err({ code, message, retriable: false });
}

function remoteKey(field: ChannelPushCatalogField): Result<string, ChannelConnectorError> {
  if (typeof field.remoteKey !== "string" || field.remoteKey.trim() === "") {
    return catalogPushError("WOO_REMOTE_KEY_REQUIRED", `WooCommerce remoteKey is required for catalog field "${field.fieldPath}".`);
  }
  return Ok(field.remoteKey.trim());
}

function porulleMetaKey(key: string): string {
  const normalized = key.trim();
  return normalized.startsWith(PORULLE_META_PREFIX) ? normalized : `${PORULLE_META_PREFIX}${normalized}`;
}

function tagValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim() !== "") return [entry.trim()];
    if (typeof entry === "number" && Number.isFinite(entry)) return [String(entry)];
    const object = asRecord(entry);
    return typeof object?.name === "string" && object.name.trim() !== "" ? [object.name.trim()] : [];
  });
}

function filterableTerms(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim() !== "") return [entry.trim()];
    if (typeof entry === "number" && Number.isFinite(entry)) return [String(entry)];
    return [];
  }))];
}

function addNativeField(
  body: WooUpdate,
  locales: Map<string, string | undefined>,
  field: ChannelPushCatalogField,
  key: string,
): void {
  const currentLocale = locales.get(key);
  if (!Object.prototype.hasOwnProperty.call(body, key) || (field.locale === "en" && currentLocale !== "en")) {
    body[key] = field.value;
    locales.set(key, field.locale);
  }
}

function addMetaField(
  metaData: Array<{ key: string; value: unknown }>,
  locales: Map<string, string | undefined>,
  field: ChannelPushCatalogField,
  key: string,
): void {
  const currentLocale = locales.get(key);
  const existingIndex = metaData.findIndex((entry) => entry.key === key);
  if (existingIndex === -1 || (field.locale === "en" && currentLocale !== "en")) {
    const entry = { key, value: field.value };
    if (existingIndex === -1) metaData.push(entry);
    else metaData[existingIndex] = entry;
    locales.set(key, field.locale);
  }
}

function appendCatalogFields(
  fields: ChannelPushCatalogField[],
  nativeFields: ReadonlySet<string>,
  body: WooUpdate,
  filterableFields: ChannelPushCatalogField[],
  metaData: Array<{ key: string; value: unknown }>,
  tags: Set<string>,
): Result<{ hasTagField: boolean }, ChannelConnectorError> {
  const locales = new Map<string, string | undefined>();
  const metaLocales = new Map<string, string | undefined>();
  let hasTagField = false;
  for (const field of fields) {
    if (field.intent === "filterable") {
      const key = remoteKey(field);
      if (!key.ok) return key;
      filterableFields.push(field);
      continue;
    }
    if (field.intent === "tag") {
      hasTagField = true;
      for (const tag of tagValues(field.value)) tags.add(tag);
      continue;
    }
    const key = remoteKey(field);
    if (!key.ok) return key;
    if (nativeFields.has(key.value)) {
      addNativeField(body, locales, field, key.value);
    } else {
      addMetaField(metaData, metaLocales, field, porulleMetaKey(key.value));
    }
  }
  return Ok({ hasTagField });
}

function wooImages(images: NonNullable<ChannelPushCatalogItem["images"]>): Array<Record<string, unknown>> {
  return images.map((image, index) => ({
    ...(image.externalId?.trim() ? { id: batchId(image.externalId.trim()) } : { src: image.url }),
    ...(image.alt !== undefined ? { alt: image.alt } : {}),
    position: image.sortOrder ?? index,
  }));
}

function mergeWooImages(
  current: NonNullable<WooProduct["images"]>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const incomingById = new Map<string, Record<string, unknown>>();
  for (const image of incoming) {
    if (typeof image.id === "number" || typeof image.id === "string") incomingById.set(String(image.id), image);
  }
  const currentIds = new Set(current.map((image) => String(image.id)));
  const merged = current.map((image, index) => {
    const replacement = incomingById.get(String(image.id));
    return replacement ?? {
      id: image.id,
      ...(image.alt !== undefined ? { alt: image.alt } : {}),
      position: image.position ?? index,
    };
  });
  const appendedIds = new Set<string>();
  for (const image of incoming) {
    if (typeof image.id === "number" || typeof image.id === "string") {
      const id = String(image.id);
      if (currentIds.has(id) || appendedIds.has(id)) continue;
      appendedIds.add(id);
    }
    merged.push(image);
  }
  return merged;
}

function batchId(externalId: string): string | number {
  return /^\d+$/.test(externalId) ? Number(externalId) : externalId;
}

function buildCatalogPlan(item: ChannelPushCatalogItem): Result<WooCatalogPlan, ChannelConnectorError> {
  const productBody: WooUpdate = {};
  const productFilterableFields: ChannelPushCatalogField[] = [];
  const productMetaData: Array<{ key: string; value: unknown }> = [];
  const productTags = new Set<string>();
  const productFields = appendCatalogFields(item.fields, wooProductNativeFields, productBody, productFilterableFields, productMetaData, productTags);
  if (!productFields.ok) return productFields;
  if (productMetaData.length > 0) productBody.meta_data = productMetaData;
  if (productFields.value.hasTagField) productBody.tags = [...productTags].map((name) => ({ name }));
  if (item.images !== undefined) productBody.images = wooImages(item.images);

  const variants: WooCatalogPlan["variants"] = [];
  for (const variant of item.variants ?? []) {
    const variantBody: WooUpdate = {};
    const filterableFields: ChannelPushCatalogField[] = [];
    const metaData: Array<{ key: string; value: unknown }> = [];
    const tags = new Set<string>();
    const variantFields = appendCatalogFields(variant.fields, wooVariationNativeFields, variantBody, filterableFields, metaData, tags);
    if (!variantFields.ok) return variantFields;
    if (filterableFields.length > 0) {
      return catalogPushError("WOO_VARIANT_FILTERABLE_UNSUPPORTED", `WooCommerce filterable fields must be assigned on product "${item.externalId}", not variation "${variant.externalId}".`);
    }
    if (variantFields.value.hasTagField) {
      return catalogPushError("WOO_VARIANT_TAG_UNSUPPORTED", `WooCommerce tags must be assigned on product "${item.externalId}", not variation "${variant.externalId}".`);
    }
    if (metaData.length > 0) variantBody.meta_data = metaData;
    variants.push({ variant, body: variantBody });
  }

  return Ok({ productBody, filterableFields: productFilterableFields, variants });
}

function taxonomyParts(remoteName: string): { base: string; taxonomy: string; name: string } {
  const withoutPrefix = remoteName.trim().toLowerCase().replace(/^pa[_-]/, "");
  const base = withoutPrefix.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    base,
    taxonomy: `pa_${base}`,
    name: withoutPrefix.replace(/[-_]+/g, " ").trim(),
  };
}

async function ensureGlobalAttribute(
  client: WooClient,
  store: ChannelStore,
  remoteName: string,
): Promise<Result<WooGlobalAttribute, ChannelConnectorError>> {
  const parts = taxonomyParts(remoteName);
  const existing = await client.get("/wc/v3/products/attributes", z.array(globalAttributeSchema), { search: parts.name });
  if (!existing.ok) return existing;
  const found = existing.value.data.find((attribute) => {
    const slug = attribute.slug?.toLowerCase();
    return slug === parts.taxonomy || slug === parts.base || attribute.name.toLowerCase() === parts.name;
  });
  if (found) return Ok(found);
  return client.send("POST", "/wc/v3/products/attributes", { name: parts.name, slug: parts.base }, globalAttributeSchema);
}

async function ensureTerm(
  client: WooClient,
  store: ChannelStore,
  attributeId: number | string,
  termName: string,
): Promise<Result<WooTerm, ChannelConnectorError>> {
  const path = `/wc/v3/products/attributes/${encodeURIComponent(String(attributeId))}/terms`;
  const existing = await client.get(path, z.array(termSchema), { search: termName });
  if (!existing.ok) return existing;
  const found = existing.value.data.find((term) => term.name.toLowerCase() === termName.toLowerCase());
  if (found) return Ok(found);
  return client.send("POST", path, { name: termName }, termSchema);
}

async function mergedFilterableAttributes(
  client: WooClient,
  store: ChannelStore,
  productId: string,
  fields: ChannelPushCatalogField[],
  attributeCache: Map<string, Promise<Result<WooGlobalAttribute, ChannelConnectorError>>>,
  termCache: Map<string, Promise<Result<WooTerm, ChannelConnectorError>>>,
): Promise<Result<NonNullable<WooProduct["attributes"]>, ChannelConnectorError>> {
  const termsByRemoteName = new Map<string, Set<string>>();
  for (const field of fields) {
    const key = remoteKey(field);
    if (!key.ok) return key;
    const terms = termsByRemoteName.get(key.value) ?? new Set<string>();
    for (const term of filterableTerms(field.value)) terms.add(term);
    termsByRemoteName.set(key.value, terms);
  }

  const assignments: Array<{ attribute: WooGlobalAttribute; terms: string[] }> = [];
  for (const [remoteName, termNames] of termsByRemoteName) {
    const parts = taxonomyParts(remoteName);
    const attributeKey = `${store.storeDomain}|${parts.taxonomy}`;
    let attributePromise = attributeCache.get(attributeKey);
    if (!attributePromise) {
      attributePromise = ensureGlobalAttribute(client, store, remoteName);
      attributeCache.set(attributeKey, attributePromise);
    }
    const attribute = await attributePromise;
    if (!attribute.ok) {
      attributeCache.delete(attributeKey);
      return attribute;
    }
    const terms: string[] = [];
    for (const termName of termNames) {
      const termKey = `${store.storeDomain}|${String(attribute.value.id)}|${termName.toLowerCase()}`;
      let termPromise = termCache.get(termKey);
      if (!termPromise) {
        termPromise = ensureTerm(client, store, attribute.value.id, termName);
        termCache.set(termKey, termPromise);
      }
      const term = await termPromise;
      if (!term.ok) {
        termCache.delete(termKey);
        return term;
      }
      terms.push(term.value.name);
    }
    assignments.push({ attribute: attribute.value, terms });
  }

  const current = await client.get(`/wc/v3/products/${encodeURIComponent(productId)}`, pushProductSchema);
  if (!current.ok) return current;
  const merged = (current.value.data.attributes ?? []).map((attribute) => ({
    ...attribute,
    ...(attribute.options ? { options: [...attribute.options] } : {}),
  }));
  for (const assignment of assignments) {
    const existing = merged.find((attribute) => attribute.id !== undefined && String(attribute.id) === String(assignment.attribute.id));
    if (existing) {
      existing.visible = existing.visible ?? true;
      existing.variation = existing.variation ?? false;
      existing.options = [...new Set([...(existing.options ?? []), ...assignment.terms])];
    } else {
      merged.push({
        id: assignment.attribute.id,
        name: assignment.attribute.name,
        visible: true,
        variation: false,
        options: assignment.terms,
      });
    }
  }
  return Ok(merged);
}

async function updateProduct(
  client: WooClient,
  store: ChannelStore,
  item: ChannelPushCatalogItem,
  plan: WooCatalogPlan,
  attributeCache: Map<string, Promise<Result<WooGlobalAttribute, ChannelConnectorError>>>,
  termCache: Map<string, Promise<Result<WooTerm, ChannelConnectorError>>>,
): Promise<Result<void, ChannelConnectorError>> {
  const body: WooUpdate = { ...plan.productBody };
  if (Array.isArray(body.images)) {
    const current = await client.get(`/wc/v3/products/${encodeURIComponent(item.externalId)}`, pushProductSchema);
    if (!current.ok) return current;
    body.images = mergeWooImages(current.value.data.images ?? [], body.images as Array<Record<string, unknown>>);
  }
  if (plan.filterableFields.length > 0) {
    const attributes = await mergedFilterableAttributes(client, store, item.externalId, plan.filterableFields, attributeCache, termCache);
    if (!attributes.ok) return attributes;
    body.attributes = attributes.value;
  }
  if (Object.keys(body).length === 0) return Ok(undefined);
  const result = await client.send("PUT", `/wc/v3/products/${encodeURIComponent(item.externalId)}`, body, z.unknown());
  return result.ok ? Ok(undefined) : result;
}

async function updateVariant(
  client: WooClient,
  store: ChannelStore,
  productId: string,
  variant: ChannelPushCatalogVariant,
  body: WooUpdate,
): Promise<Result<void, ChannelConnectorError>> {
  if (Object.keys(body).length === 0) return Ok(undefined);
  const result = await client.send("PUT", `/wc/v3/products/${encodeURIComponent(productId)}/variations/${encodeURIComponent(variant.externalId)}`, body, z.unknown());
  return result.ok ? Ok(undefined) : result;
}

async function pushCatalogItem(
  client: WooClient,
  store: ChannelStore,
  item: ChannelPushCatalogItem,
  plan: WooCatalogPlan,
  attributeCache: Map<string, Promise<Result<WooGlobalAttribute, ChannelConnectorError>>>,
  termCache: Map<string, Promise<Result<WooTerm, ChannelConnectorError>>>,
): Promise<Result<void, ChannelConnectorError>> {
  const product = await updateProduct(client, store, item, plan, attributeCache, termCache);
  if (!product.ok) return product;
  for (const variant of plan.variants) {
    const updated = await updateVariant(client, store, item.externalId, variant.variant, variant.body);
    if (!updated.ok) return updated;
  }
  return Ok(undefined);
}

async function pushCatalogBatch(
  client: WooClient,
  store: ChannelStore,
  entries: Array<{ index: number; item: ChannelPushCatalogItem; plan: WooCatalogPlan }>,
): Promise<Result<Array<{ index: number; error?: ChannelConnectorError }>, ChannelConnectorError>> {
  const update = entries.map(({ item, plan }) => ({ id: batchId(item.externalId), ...plan.productBody }));
  const result = await client.send("POST", "/wc/v3/products/batch", { update }, batchResponseSchema);
  if (!result.ok) return result;
  const responseById = new Map((result.value.update ?? []).map((entry) => [String(entry.id), entry]));
  return Ok(entries.map((entry) => {
    const responseEntry = responseById.get(String(batchId(entry.item.externalId)));
    if (!responseEntry) {
      return { index: entry.index, error: { code: "WOO_API_FAILED", message: "WooCommerce batch response omitted this product.", retriable: false } };
    }
    return responseEntry.error === undefined ? { index: entry.index } : { index: entry.index, error: batchItemError(responseEntry.error) };
  }));
}


export async function pushCatalog(client: WooClient, store: ChannelStore, items: ChannelPushCatalogItem[], opts: { dryRun?: boolean } | undefined, caches: PushCaches): Promise<Result<ChannelPushCatalogResult, ChannelConnectorError>> {
  const { attributeCache, termCache } = caches;
    if (store.provider !== "woocommerce") {
      return Err({ code: "WOO_INVALID_STORE_PROVIDER", message: "WooCommerce catalog pushes require a WooCommerce store.", retriable: false });
    }

    const outcomes: ChannelPushCatalogResult["outcomes"] = items.map((item) => ({ externalId: item.externalId, ok: true }));
    const planned: Array<{ index: number; item: ChannelPushCatalogItem; plan: WooCatalogPlan }> = [];
    for (const [index, item] of items.entries()) {
      const plan = buildCatalogPlan(item);
      if (!plan.ok) {
        outcomes[index] = { externalId: item.externalId, ok: false, error: plan.error };
      } else {
        planned.push({ index, item, plan: plan.value });
      }
    }
    if (opts?.dryRun) return Ok({ outcomes });

    const batchable = planned.filter(({ plan }) => plan.filterableFields.length === 0 && plan.variants.length === 0 && !Object.prototype.hasOwnProperty.call(plan.productBody, "images") && Object.keys(plan.productBody).length > 0);
    const batched = new Set<number>();
    if (batchable.length > 1) {
      for (let offset = 0; offset < batchable.length; offset += WOO_BATCH_LIMIT) {
        const chunk = batchable.slice(offset, offset + WOO_BATCH_LIMIT);
        const batchResult = await pushCatalogBatch(client, store, chunk);
        for (const entry of chunk) {
          batched.add(entry.index);
        }
        if (!batchResult.ok) {
          for (const entry of chunk) outcomes[entry.index] = { externalId: entry.item.externalId, ok: false, error: batchResult.error };
        } else {
          const entryByIndex = new Map(chunk.map((entry) => [entry.index, entry.item]));
          for (const entry of batchResult.value) {
            if (entry.error) {
              const item = entryByIndex.get(entry.index);
              if (item) outcomes[entry.index] = { externalId: item.externalId, ok: false, error: entry.error };
            }
          }
        }
      }
    }
    for (const entry of planned) {
      if (batched.has(entry.index)) continue;
      const pushed = await pushCatalogItem(client, store, entry.item, entry.plan, attributeCache, termCache);
      if (!pushed.ok) outcomes[entry.index] = { externalId: entry.item.externalId, ok: false, error: pushed.error };
    }
    return Ok({ outcomes });
  }
