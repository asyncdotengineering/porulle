import { defineChannelConnector, Err, Ok } from "@porulle/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelCatalogPage,
  ChannelCatalogPrice,
  ChannelConnector,
  ChannelConnectorError,
  ChannelInventoryLevel,
  ChannelPushCatalogField,
  ChannelPushCatalogItem,
  ChannelPushCatalogResult,
  ChannelPushCatalogVariant,
  ChannelStore,
  ChannelOrderSlice,
  ChannelOrderStatus,
  Result,
} from "@porulle/core";

export interface WooConnectorOptions { fetchImpl?: typeof fetch }

type WooProduct = {
  id: number | string;
  name: string;
  slug?: string;
  description?: string | null;
  status?: string | null;
  images?: Array<{ id: number | string; src: string; alt?: string | null; position?: number | null }>;
  attributes?: Array<{ id?: number | string; name: string; visible?: boolean | null; variation?: boolean | null; position?: number | null; options?: string[] }>;
  tags?: Array<{ slug?: string | null }>;
  categories?: Array<{ slug?: string | null }>;
  variations?: Array<number | string | {
    id: number | string;
    sku?: string | null;
    price?: string | null;
    attributes?: Array<{ name: string; option?: string | null }>;
  }>;
  stock_quantity?: number | null;
};

type WooProductVariation = {
  id: number | string;
  sku?: string | null;
  price?: string | null;
  attributes?: Array<{ name: string; option?: string | null }>;
};

type WooGlobalAttribute = {
  id: number | string;
  name: string;
  slug?: string | null;
};

type WooTerm = {
  id: number | string;
  name: string;
};

type WooUpdate = Record<string, unknown>;

type WooBatchEntry = {
  id?: number | string;
  error?: unknown;
};

type WooBatchResponse = {
  update?: WooBatchEntry[];
};

type WooRequestOptions = {
  retryableClientErrors?: boolean;
};

type WooCatalogPlan = {
  productBody: WooUpdate;
  filterableFields: ChannelPushCatalogField[];
  variants: Array<{ variant: ChannelPushCatalogVariant; body: WooUpdate }>;
};

const PORULLE_META_PREFIX = "porulle_";
const WOO_BATCH_LIMIT = 100;
const catalogRequestOptions: WooRequestOptions = { retryableClientErrors: true };

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

const zeroDecimalCurrencies = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function buildWooUrl(base: string, path: string, key: string, secret: string, page: number, cursor?: string): string {
  const url = new URL(path, base.replace(/\/$/, "/"));
  url.searchParams.set("consumer_key", key);
  url.searchParams.set("consumer_secret", secret);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  if (cursor) url.searchParams.set("modified_after", cursor);
  return url.toString();
}

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toUpperCase();
}

function parseMoney(value: string | null | undefined, currency: string): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const exponent = zeroDecimalCurrencies.has(currency) ? 0 : 2;
  return Math.round(parsed * (10 ** exponent));
}

function pricesForVariation(variation: WooProductVariation, currency: string | undefined): ChannelCatalogPrice[] | undefined {
  if (!currency) return undefined;
  const amount = parseMoney(variation.price, currency);
  return amount === undefined ? undefined : [{ currency, amount }];
}

function catalogStatus(value: string | null | undefined): "draft" | "active" | undefined {
  if (value === "publish") return "active";
  if (value === "draft" || value === "private") return "draft";
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function settingCurrency(data: unknown): string | undefined {
  if (Array.isArray(data)) {
    for (const entry of data) {
      const setting = asRecord(entry);
      if (setting?.id === "woocommerce_currency") return normalizeCurrency(setting.value);
    }
  }
  const object = asRecord(data);
  if (!object) return undefined;
  const direct = normalizeCurrency(object.woocommerce_currency);
  if (direct) return direct;
  const systemStatus = asRecord(object.system_status);
  return normalizeCurrency(systemStatus?.woocommerce_currency);
}

async function fetchWooCurrency(fetchImpl: typeof fetch, url: string): Promise<string | undefined> {
  const result = await request<unknown>(fetchImpl, url);
  return result.ok ? settingCurrency(result.value.data) : undefined;
}

async function fetchProductVariations(
  fetchImpl: typeof fetch,
  storeDomain: string,
  auth: { key: string; secret: string },
  productId: string,
  modifiedAfter: string | undefined,
): Promise<Result<WooProductVariation[]>> {
  const variations: WooProductVariation[] = [];
  let page = 1;
  while (true) {
    const result = await request<WooProductVariation[]>(fetchImpl, buildWooUrl(storeDomain, `/wp-json/wc/v3/products/${encodeURIComponent(productId)}/variations`, auth.key, auth.secret, page, modifiedAfter));
    if (!result.ok) return result;
    variations.push(...result.value.data);
    const totalPages = Number.parseInt(result.value.response.headers.get("x-wp-totalpages") ?? "1", 10);
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
    page += 1;
  }
  return Ok(variations);
}

function variationFromReference(reference: NonNullable<WooProduct["variations"]>[number]): WooProductVariation {
  return typeof reference === "object" && reference !== null ? reference : { id: reference };
}

function mergeProductVariations(
  references: NonNullable<WooProduct["variations"]>,
  details: WooProductVariation[],
): WooProductVariation[] {
  const detailById = new Map(details.map((variation) => [String(variation.id), variation]));
  const referencedIds = new Set<string>();
  const merged = references.map((reference) => {
    const fallback = variationFromReference(reference);
    const id = String(fallback.id);
    referencedIds.add(id);
    return detailById.get(id) ?? fallback;
  });
  return [...merged, ...details.filter((variation) => !referencedIds.has(String(variation.id)))];
}

function isRetriableStatus(status: number | undefined, options?: WooRequestOptions): boolean {
  return status !== undefined && (status >= 500 || (options?.retryableClientErrors === true && (status === 408 || status === 429)));
}

async function request<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit, options?: WooRequestOptions): Promise<Result<{ data: T; response: Response }>> {
  try {
    const response = await fetchImpl(url, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
    if (!response.ok) return Err({ code: "WOO_API_FAILED", message: `WooCommerce request failed (${response.status}) for ${url}.`, retriable: isRetriableStatus(response.status, options) });
    return Ok({ data: await response.json() as T, response });
  } catch (error) {
    return Err({ code: "WOO_API_FAILED", message: error instanceof Error ? error.message : "WooCommerce request failed.", retriable: true });
  }
}

function connectorError(error: { code: string; message: string; retriable?: boolean }): ChannelConnectorError {
  return {
    code: error.code,
    message: error.message,
    ...(error.retriable !== undefined ? { retriable: error.retriable } : {}),
  };
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
    retriable: isRetriableStatus(batchErrorStatus(error), { retryableClientErrors: true }),
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

function queryUrl(
  storeDomain: string,
  path: string,
  key: string,
  secret: string,
  params: Record<string, string>,
): string {
  const url = new URL(buildWooUrl(storeDomain, path, key, secret, 1));
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
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
  fetchImpl: typeof fetch,
  store: ChannelStore,
  auth: { key: string; secret: string },
  remoteName: string,
): Promise<Result<WooGlobalAttribute, ChannelConnectorError>> {
  const parts = taxonomyParts(remoteName);
  const existing = await request<WooGlobalAttribute[]>(fetchImpl, queryUrl(store.storeDomain, "/wp-json/wc/v3/products/attributes", auth.key, auth.secret, { search: parts.name }), undefined, catalogRequestOptions);
  if (!existing.ok) return Err(connectorError(existing.error));
  const found = existing.value.data.find((attribute) => {
    const slug = attribute.slug?.toLowerCase();
    return slug === parts.taxonomy || slug === parts.base || attribute.name.toLowerCase() === parts.name;
  });
  if (found) return Ok(found);
  const created = await request<WooGlobalAttribute>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/products/attributes", auth.key, auth.secret, 1), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: parts.name, slug: parts.base }),
  }, catalogRequestOptions);
  return created.ok ? Ok(created.value.data) : Err(connectorError(created.error));
}

async function ensureTerm(
  fetchImpl: typeof fetch,
  store: ChannelStore,
  auth: { key: string; secret: string },
  attributeId: number | string,
  termName: string,
): Promise<Result<WooTerm, ChannelConnectorError>> {
  const path = `/wp-json/wc/v3/products/attributes/${encodeURIComponent(String(attributeId))}/terms`;
  const existing = await request<WooTerm[]>(fetchImpl, queryUrl(store.storeDomain, path, auth.key, auth.secret, { search: termName }), undefined, catalogRequestOptions);
  if (!existing.ok) return Err(connectorError(existing.error));
  const found = existing.value.data.find((term) => term.name.toLowerCase() === termName.toLowerCase());
  if (found) return Ok(found);
  const created = await request<WooTerm>(fetchImpl, buildWooUrl(store.storeDomain, path, auth.key, auth.secret, 1), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: termName }),
  }, catalogRequestOptions);
  return created.ok ? Ok(created.value.data) : Err(connectorError(created.error));
}

async function mergedFilterableAttributes(
  fetchImpl: typeof fetch,
  store: ChannelStore,
  auth: { key: string; secret: string },
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
      attributePromise = ensureGlobalAttribute(fetchImpl, store, auth, remoteName);
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
        termPromise = ensureTerm(fetchImpl, store, auth, attribute.value.id, termName);
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

  const current = await request<WooProduct>(fetchImpl, buildWooUrl(store.storeDomain, `/wp-json/wc/v3/products/${encodeURIComponent(productId)}`, auth.key, auth.secret, 1), undefined, catalogRequestOptions);
  if (!current.ok) return Err(connectorError(current.error));
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
  fetchImpl: typeof fetch,
  store: ChannelStore,
  auth: { key: string; secret: string },
  item: ChannelPushCatalogItem,
  plan: WooCatalogPlan,
  attributeCache: Map<string, Promise<Result<WooGlobalAttribute, ChannelConnectorError>>>,
  termCache: Map<string, Promise<Result<WooTerm, ChannelConnectorError>>>,
): Promise<Result<void, ChannelConnectorError>> {
  const body: WooUpdate = { ...plan.productBody };
  if (Array.isArray(body.images)) {
    const current = await request<WooProduct>(fetchImpl, buildWooUrl(store.storeDomain, `/wp-json/wc/v3/products/${encodeURIComponent(item.externalId)}`, auth.key, auth.secret, 1), undefined, catalogRequestOptions);
    if (!current.ok) return Err(connectorError(current.error));
    body.images = mergeWooImages(current.value.data.images ?? [], body.images as Array<Record<string, unknown>>);
  }
  if (plan.filterableFields.length > 0) {
    const attributes = await mergedFilterableAttributes(fetchImpl, store, auth, item.externalId, plan.filterableFields, attributeCache, termCache);
    if (!attributes.ok) return attributes;
    body.attributes = attributes.value;
  }
  if (Object.keys(body).length === 0) return Ok(undefined);
  const result = await request<WooProduct>(fetchImpl, buildWooUrl(store.storeDomain, `/wp-json/wc/v3/products/${encodeURIComponent(item.externalId)}`, auth.key, auth.secret, 1), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, catalogRequestOptions);
  return result.ok ? Ok(undefined) : Err(connectorError(result.error));
}

async function updateVariant(
  fetchImpl: typeof fetch,
  store: ChannelStore,
  auth: { key: string; secret: string },
  productId: string,
  variant: ChannelPushCatalogVariant,
  body: WooUpdate,
): Promise<Result<void, ChannelConnectorError>> {
  if (Object.keys(body).length === 0) return Ok(undefined);
  const result = await request<WooProductVariation>(fetchImpl, buildWooUrl(store.storeDomain, `/wp-json/wc/v3/products/${encodeURIComponent(productId)}/variations/${encodeURIComponent(variant.externalId)}`, auth.key, auth.secret, 1), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, catalogRequestOptions);
  return result.ok ? Ok(undefined) : Err(connectorError(result.error));
}

async function pushCatalogItem(
  fetchImpl: typeof fetch,
  store: ChannelStore,
  auth: { key: string; secret: string },
  item: ChannelPushCatalogItem,
  plan: WooCatalogPlan,
  attributeCache: Map<string, Promise<Result<WooGlobalAttribute, ChannelConnectorError>>>,
  termCache: Map<string, Promise<Result<WooTerm, ChannelConnectorError>>>,
): Promise<Result<void, ChannelConnectorError>> {
  const product = await updateProduct(fetchImpl, store, auth, item, plan, attributeCache, termCache);
  if (!product.ok) return product;
  for (const variant of plan.variants) {
    const updated = await updateVariant(fetchImpl, store, auth, item.externalId, variant.variant, variant.body);
    if (!updated.ok) return updated;
  }
  return Ok(undefined);
}

async function pushCatalogBatch(
  fetchImpl: typeof fetch,
  store: ChannelStore,
  auth: { key: string; secret: string },
  entries: Array<{ index: number; item: ChannelPushCatalogItem; plan: WooCatalogPlan }>,
): Promise<Result<Array<{ index: number; error?: ChannelConnectorError }>, ChannelConnectorError>> {
  const update = entries.map(({ item, plan }) => ({ id: batchId(item.externalId), ...plan.productBody }));
  const result = await request<WooBatchResponse>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/products/batch", auth.key, auth.secret, 1), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ update }),
  }, { retryableClientErrors: true });
  if (!result.ok) return Err(connectorError(result.error));
  const responseById = new Map((result.value.data.update ?? []).map((entry) => [String(entry.id), entry]));
  return Ok(entries.map((entry) => {
    const responseEntry = responseById.get(String(batchId(entry.item.externalId)));
    if (!responseEntry) {
      return { index: entry.index, error: { code: "WOO_API_FAILED", message: "WooCommerce batch response omitted this product.", retriable: false } };
    }
    return responseEntry.error === undefined ? { index: entry.index } : { index: entry.index, error: batchItemError(responseEntry.error) };
  }));
}

function wooStatus(status: string | undefined): ChannelOrderStatus {
  if (status === "completed") return { status: "fulfilled" };
  if (status === "processing" || status === "on-hold") return { status: "confirmed" };
  if (status === "cancelled") return { status: "cancelled" };
  if (status === "failed" || status === "refunded") return { status: "failed" };
  return { status: "pending" };
}

function credentials(store: ChannelStore): { key: string; secret: string } | undefined {
  const key = store.credentials.consumerKey;
  const secret = store.credentials.consumerSecret;
  return typeof key === "string" && typeof secret === "string" && key && secret ? { key, secret } : undefined;
}

function validBase64Hmac(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(signature, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function oauthError(code: string, message: string): Result<never, ChannelConnectorError> {
  return Err({ code, message, retriable: false });
}

function storeUrl(domain: string): URL | undefined {
  try {
    const url = new URL(/^https?:\/\//i.test(domain) ? domain : `https://${domain}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

export function wooConnector(options: WooConnectorOptions = {}): ChannelConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const currencyCache = new Map<string, Promise<string | undefined>>();
  const attributeCache = new Map<string, Promise<Result<WooGlobalAttribute, ChannelConnectorError>>>();
  const termCache = new Map<string, Promise<Result<WooTerm, ChannelConnectorError>>>();
  return defineChannelConnector({
    providerId: "woocommerce",
    capabilities: { importCatalog: true, importInventory: true, pushOrder: true, pushCatalog: true, receiveWebhooks: true },
    buildAuthUrl(params) {
      const store = storeUrl(params.storeDomain);
      if (!store) return oauthError("WOO_INVALID_STORE_DOMAIN", "WooCommerce storeDomain must be an HTTP(S) URL.");
      let callback: URL;
      try {
        callback = new URL(params.callbackUri);
      } catch {
        return oauthError("WOO_INVALID_CALLBACK_URL", "WooCommerce callbackUri must be an HTTPS URL.");
      }
      if (callback.protocol !== "https:") return oauthError("WOO_INVALID_CALLBACK_URL", "WooCommerce callbackUri must be an HTTPS URL.");
      callback.searchParams.set("state", params.state);
      const returnUrl = new URL(params.callbackUri);
      returnUrl.searchParams.set("state", params.state);
      returnUrl.searchParams.set("return", "1");
      const url = new URL("/wc-auth/v1/authorize", store.origin);
      url.searchParams.set("app_name", "Porulle");
      url.searchParams.set("scope", "read_write");
      url.searchParams.set("user_id", "porulle");
      url.searchParams.set("return_url", returnUrl.toString());
      url.searchParams.set("callback_url", callback.toString());
      return Ok(url.toString());
    },
    async completeAuth(request, ctx) {
      if (request.method !== "POST") return oauthError("WOO_AUTH_METHOD_REQUIRED", "WooCommerce auth credentials must be posted.");
      const store = storeUrl(ctx.storeDomain);
      if (!store) return oauthError("WOO_INVALID_STORE_DOMAIN", "WooCommerce storeDomain must be an HTTP(S) URL.");
      try {
        const body = await request.json() as Record<string, unknown>;
        const consumerKey = body.consumer_key;
        const consumerSecret = body.consumer_secret;
        if (typeof consumerKey !== "string" || !consumerKey || typeof consumerSecret !== "string" || !consumerSecret) {
          return oauthError("WOO_AUTH_CREDENTIALS_INVALID", "WooCommerce auth response must include consumer_key and consumer_secret.");
        }
        return Ok({ credentials: { consumerKey, consumerSecret }, storeDomain: ctx.storeDomain });
      } catch {
        return oauthError("WOO_AUTH_RESPONSE_INVALID", "WooCommerce auth response must be valid JSON.");
      }
    },
    async importCatalog(store, cursor): Promise<Result<ChannelCatalogPage>> {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required." });
      const [pagePart, ...afterParts] = cursor?.split("|") ?? [];
      const isPage = pagePart === undefined || /^\d+$/.test(pagePart);
      const parsedPage = isPage && pagePart ? Number.parseInt(pagePart, 10) : 1;
      const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
      const modifiedAfter = afterParts.length > 0 ? afterParts.join("|") : (!isPage ? cursor : undefined);
      const currencyKey = store.storeDomain.replace(/\/$/, "");
      let currencyPromise = currencyCache.get(currencyKey);
      if (!currencyPromise) {
        currencyPromise = fetchWooCurrency(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/settings/general", auth.key, auth.secret, 1));
        currencyCache.set(currencyKey, currencyPromise);
      }
      const currency = await currencyPromise;
      const result = await request<WooProduct[]>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/products", auth.key, auth.secret, page, modifiedAfter));
      if (!result.ok) return result;
      const totalPages = Number.parseInt(result.value.response.headers.get("x-wp-totalpages") ?? "1", 10);
      const nextCursor = page < totalPages ? (modifiedAfter ? `${page + 1}|${modifiedAfter}` : String(page + 1)) : null;
      const items = [];
      for (const product of result.value.data) {
        const references = product.variations ?? [];
        const details = references.length > 0
          ? await fetchProductVariations(fetchImpl, store.storeDomain, auth, String(product.id), modifiedAfter)
          : Ok<WooProductVariation[]>([]);
        if (!details.ok) return details;
        const variants = mergeProductVariations(references, details.value).map((variant) => {
          const optionValues = Object.fromEntries((variant.attributes ?? []).flatMap((attribute) => (
            attribute.option != null && attribute.option !== "" ? [[attribute.name, attribute.option] as const] : []
          )));
          const prices = pricesForVariation(variant, currency);
          return {
            externalId: String(variant.id),
            ...(variant.sku ? { sku: variant.sku } : {}),
            ...(Object.keys(optionValues).length > 0 ? { optionValues } : {}),
            ...(prices ? { prices } : {}),
          };
        });
        const options = product.attributes?.filter((attribute) => attribute.variation === true).map((attribute, index) => ({
          name: attribute.name,
          displayName: attribute.name,
          ...(attribute.position != null ? { sortOrder: attribute.position } : { sortOrder: index }),
          values: (attribute.options ?? []).map((value, valueIndex) => ({ value, displayValue: value, sortOrder: valueIndex })),
        }));
        const status = catalogStatus(product.status);
        items.push({
          externalId: String(product.id),
          slug: product.slug ?? String(product.id),
          title: product.name,
          attributes: [{ locale: "en", title: product.name, ...(product.description != null ? { description: product.description } : {}) }],
          variants,
          ...(product.images ? {
            images: product.images.map((image, index) => ({
              externalId: String(image.id),
              url: image.src,
              ...(image.alt != null ? { alt: image.alt } : {}),
              role: index === 0 ? "primary" as const : "gallery" as const,
              ...(image.position != null ? { sortOrder: image.position } : {}),
            })),
          } : {}),
          ...(options ? { options } : {}),
          ...(product.tags ? { tags: product.tags.flatMap((tag) => tag.slug ? [tag.slug] : []) } : {}),
          ...(product.categories ? { categories: product.categories.flatMap((category) => category.slug ? [category.slug] : []) } : {}),
          ...(status ? { status } : {}),
        });
      }
      return Ok({ items, nextCursor });
    },
    async fetchInventory(store, ids): Promise<Result<ChannelInventoryLevel[]>> {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required." });
      const page = await request<WooProduct[]>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/products", auth.key, auth.secret, 1));
      if (!page.ok) return page;
      const requested = ids ? new Set(ids) : undefined;
      return Ok(page.value.data.filter((product) => !requested || requested.has(String(product.id))).map((product) => ({ externalId: String(product.id), available: product.stock_quantity ?? 0 })));
    },
    async pushOrder(store, slice: ChannelOrderSlice) {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required.", retriable: false });
      const url = buildWooUrl(store.storeDomain, "/wp-json/wc/v3/orders", auth.key, auth.secret, 1);
      const [firstName, ...lastParts] = slice.customer.name.trim().split(/\s+/);
      const address = slice.customer.shippingAddress;
      const billing = { first_name: firstName ?? "", last_name: lastParts.join(" "), email: slice.customer.email, ...address };
      const result = await request<{ id: number | string }>(fetchImpl, url, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `porulle:${slice.orderId}` },
        body: JSON.stringify({ set_paid: true, line_items: slice.lines.map((line) => ({ variation_id: line.externalVariantId, quantity: line.quantity, total: line.totalPrice / 100 })), billing, shipping: address }),
      });
      if (!result.ok) return result;
      const id = String(result.value.data.id);
      return Ok({ remoteOrderId: id, remoteUrl: `${store.storeDomain.replace(/\/$/, "")}/wp-admin/post.php?post=${id}&action=edit` });
    },
    async pushCatalog(store, items, opts): Promise<Result<ChannelPushCatalogResult, ChannelConnectorError>> {
      if (store.provider !== "woocommerce") {
        return Err({ code: "WOO_INVALID_STORE_PROVIDER", message: "WooCommerce catalog pushes require a WooCommerce store.", retriable: false });
      }
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required.", retriable: false });

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
          const batchResult = await pushCatalogBatch(fetchImpl, store, auth, chunk);
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
        const pushed = await pushCatalogItem(fetchImpl, store, auth, entry.item, entry.plan, attributeCache, termCache);
        if (!pushed.ok) outcomes[entry.index] = { externalId: entry.item.externalId, ok: false, error: pushed.error };
      }
      return Ok({ outcomes });
    },
    async fetchOrderStatus(store, remoteId) {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required.", retriable: false });
      const result = await request<{ status?: string }>(fetchImpl, buildWooUrl(store.storeDomain, `/wp-json/wc/v3/orders/${encodeURIComponent(remoteId)}`, auth.key, auth.secret, 1));
      return result.ok ? Ok(wooStatus(result.value.data.status)) : result;
    },
    async verifyWebhook(store, request) {
      const body = await request.text();
      if (!validBase64Hmac(store.webhookSecret ?? "", body, request.headers.get("x-wc-webhook-signature"))) {
        return Err({ code: "INVALID_WEBHOOK_SIGNATURE", message: "Invalid WooCommerce webhook signature." });
      }
      try {
        const data = JSON.parse(body) as unknown;
        const id = request.headers.get("x-wc-webhook-id");
        const type = request.headers.get("x-wc-webhook-topic");
        if (!id || !type) return Err({ code: "INVALID_WEBHOOK", message: "WooCommerce webhook headers are incomplete." });
        return Ok({ id, type, data });
      } catch {
        return Err({ code: "INVALID_WEBHOOK", message: "WooCommerce webhook body must be valid JSON." });
      }
    },
    async registerWebhooks(store: ChannelStore, topics: string[], callbackUrl: string) {
      const auth = credentials(store);
      if (!auth) return Err({ code: "WOO_CREDENTIALS_REQUIRED", message: "WooCommerce consumerKey and consumerSecret are required." });
      for (const topic of topics) {
        const result = await request<{ id: number | string }>(fetchImpl, buildWooUrl(store.storeDomain, "/wp-json/wc/v3/webhooks", auth.key, auth.secret, 1), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: `Porulle ${topic}`, topic, delivery_url: callbackUrl, secret: store.webhookSecret }),
        });
        if (!result.ok) return result;
      }
      return Ok({ registered: topics.length });
    },
    async refundExecute() { return Err({ code: "NOT_IMPLEMENTED", message: "WooCommerce refund execution is not implemented in this slice." }); },
  });
}
