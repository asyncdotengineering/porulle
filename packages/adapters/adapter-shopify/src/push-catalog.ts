import { Err, Ok } from "@porulle/core";
import type {
  ChannelConnectorError,
  ChannelPushCatalogField,
  ChannelPushCatalogImage,
  ChannelPushCatalogImageOutcome,
  ChannelPushCatalogItem,
  ChannelPushCatalogItemOutcome,
  ChannelPushCatalogPreviousField,
  ChannelPushCatalogResult,
  ChannelStore,
  Result,
} from "@porulle/core";

export const PUSH_CATALOG_SCOPE = "write_products";
export const PORULLE_METAFIELD_NAMESPACE = "porulle";

export const SHOPIFY_NATIVE_PRODUCT_FIELDS = new Set([
  "title",
  "body_html",
  "vendor",
  "product_type",
  "handle",
  "status",
]);

export const SHOPIFY_NATIVE_VARIANT_FIELDS = new Set([
  "sku",
  "barcode",
]);

type ShopifyMetafield = {
  id: number | string;
  namespace: string;
  key: string;
  value: string;
  type?: string;
};

type ShopifyProductSnapshot = {
  id: number | string;
  title?: string | null;
  body_html?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  handle?: string | null;
  status?: string | null;
  tags?: string | null;
  updated_at?: string | null;
  variants?: ShopifyVariantSnapshot[];
};

type ShopifyVariantSnapshot = {
  id: number | string;
  sku?: string | null;
  barcode?: string | null;
};

type ShopifyProductImage = {
  id: number | string;
  src?: string | null;
  alt?: string | null;
  position?: number | null;
  variant_ids?: Array<number | string> | null;
};

const SHOPIFY_IMAGE_ROLES = new Set<ChannelPushCatalogImage["role"]>(["primary", "gallery", "thumbnail"]);

interface PushRequestResult<T> {
  ok: true;
  data: T;
  response: Response;
}

interface PushRequestFailure {
  ok: false;
  error: ChannelConnectorError;
  status?: number;
  response?: Response;
}

type PushRequestResponse<T> = PushRequestResult<T> | PushRequestFailure;

export interface PushCatalogDeps {
  fetchImpl: typeof fetch;
  apiBase: (store: ChannelStore) => string;
  credentials: (store: ChannelStore) => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}

export function shopifyGrantedScopes(store: ChannelStore): string[] {
  const raw = store.credentials.grantedScopes;
  if (Array.isArray(raw)) {
    return raw.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
  }
  if (typeof raw === "string" && raw.length > 0) {
    return raw.split(",").map((scope) => scope.trim()).filter(Boolean);
  }
  return [];
}

export function shopifyPushCatalogEnabled(store: ChannelStore): boolean {
  return shopifyGrantedScopes(store).includes(PUSH_CATALOG_SCOPE);
}

export function shopifyWriteProductsScopeMissingError(reauthorizeUrl?: string): ChannelConnectorError {
  const suffix = reauthorizeUrl
    ? ` Re-authorize at ${reauthorizeUrl}.`
    : " Re-authorize the store through the Shopify OAuth start route.";
  return {
    code: "SHOPIFY_WRITE_PRODUCTS_SCOPE_MISSING",
    message: `Shopify store is missing the ${PUSH_CATALOG_SCOPE} scope.${suffix}`,
    retriable: false,
  };
}

function parseCallLimit(header: string | null): { current: number; max: number } | undefined {
  const match = header?.match(/^(\d+)\/(\d+)$/);
  if (!match) return undefined;
  return { current: Number(match[1]), max: Number(match[2]) };
}

function metafieldType(value: unknown): string {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "number_integer" : "number_decimal";
  if (typeof value === "object" && value !== null) return "json";
  return "single_line_text_field";
}

function metafieldValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function remoteKey(field: ChannelPushCatalogField): string | undefined {
  if (typeof field.remoteKey === "string" && field.remoteKey.length > 0) return field.remoteKey;
  return undefined;
}

function missingRemoteKeyError(field: ChannelPushCatalogField): ChannelConnectorError {
  return {
    code: "SHOPIFY_REMOTE_KEY_REQUIRED",
    message: `Shopify catalog field ${field.fieldPath} requires a remoteKey.`,
    retriable: false,
  };
}

function isNativeProductField(field: ChannelPushCatalogField): boolean {
  const key = remoteKey(field);
  return field.intent === "display" && key !== undefined && SHOPIFY_NATIVE_PRODUCT_FIELDS.has(key);
}

function isNativeVariantField(field: ChannelPushCatalogField): boolean {
  const key = remoteKey(field);
  return field.intent === "display" && key !== undefined && SHOPIFY_NATIVE_VARIANT_FIELDS.has(key);
}

function isMetafieldField(field: ChannelPushCatalogField): boolean {
  if (field.intent === "filterable") return true;
  if (field.intent === "tag") return false;
  return field.intent === "display" && remoteKey(field) !== undefined && !isNativeProductField(field) && !isNativeVariantField(field);
}

function parseTags(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function mergeTags(existing: string[], pushed: string[]): string {
  return [...new Set([...existing, ...pushed])].join(", ");
}

function collectPreviousFields(
  product: ShopifyProductSnapshot,
  metafields: ShopifyMetafield[],
  variantMetafields: Map<string, ShopifyMetafield[]>,
  item: ChannelPushCatalogItem,
): ChannelPushCatalogPreviousField[] {
  const previous: ChannelPushCatalogPreviousField[] = [];
  const metafieldByKey = new Map(metafields
    .filter((entry) => entry.namespace === PORULLE_METAFIELD_NAMESPACE)
    .map((entry) => [entry.key, entry]));
  for (const field of item.fields) {
    if (field.intent === "tag") {
      const tag = field.value == null ? "" : String(field.value);
      previous.push({
        fieldPath: field.fieldPath,
        value: tag.length > 0 && parseTags(product.tags).includes(tag) ? tag : null,
      });
      continue;
    }
    if (isNativeProductField(field)) {
      const key = remoteKey(field);
      if (key !== undefined) previous.push({ fieldPath: field.fieldPath, value: product[key as keyof ShopifyProductSnapshot] ?? null });
      continue;
    }
    if (isMetafieldField(field)) {
      const key = remoteKey(field);
      if (key !== undefined) {
        const existing = metafieldByKey.get(key);
        previous.push({ fieldPath: field.fieldPath, value: existing?.value ?? null });
      }
    }
  }
  for (const variant of item.variants ?? []) {
    for (const field of variant.fields) {
      if (isNativeVariantField(field)) {
        const key = remoteKey(field);
        const snapshot = product.variants?.find((entry) => String(entry.id) === variant.externalId);
        previous.push({ fieldPath: field.fieldPath, value: key !== undefined ? snapshot?.[key as keyof ShopifyVariantSnapshot] ?? null : null });
      } else if (isMetafieldField(field)) {
        const key = remoteKey(field);
        if (key !== undefined) {
          const existing = new Map((variantMetafields.get(variant.externalId) ?? [])
            .filter((entry) => entry.namespace === PORULLE_METAFIELD_NAMESPACE)
            .map((entry) => [entry.key, entry])).get(key);
          previous.push({ fieldPath: field.fieldPath, value: existing?.value ?? null });
        }
      }
    }
  }
  return previous;
}

async function pushRequest<T>(
  deps: PushCatalogDeps,
  url: string,
  token: string,
  init?: RequestInit,
): Promise<PushRequestResponse<T>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    const response = await deps.fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.headers ?? {}),
        "x-shopify-access-token": token,
      },
    });
    const limit = parseCallLimit(response.headers.get("x-shopify-shop-api-call-limit"));
    if (limit && limit.current >= Math.max(1, limit.max - 2)) {
      await sleep(500);
    }
    if (response.status === 429) {
      return {
        ok: false,
        status: 429,
        response,
        error: {
          code: "SHOPIFY_RATE_LIMITED",
          message: "Shopify API rate limit exceeded.",
          retriable: true,
        },
      };
    }
    const method = (init?.method ?? "GET").toUpperCase();
    if (response.status === 403 && method !== "GET") {
      return {
        ok: false,
        status: 403,
        response,
        error: shopifyWriteProductsScopeMissingError(),
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        response,
        error: {
          code: "SHOPIFY_API_FAILED",
          message: `Shopify API request failed (${response.status}) for ${url}.`,
          retriable: response.status >= 500,
        },
      };
    }
    const text = await response.text();
    const data = text.length > 0 ? JSON.parse(text) as T : {} as T;
    return { ok: true, data, response };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "SHOPIFY_API_FAILED",
        message: error instanceof Error ? error.message : "Shopify API request failed.",
        retriable: true,
      },
    };
  }
}

async function loadProductSnapshot(
  deps: PushCatalogDeps,
  store: ChannelStore,
  token: string,
  externalId: string,
  variantIds: string[],
  withImages: boolean,
): Promise<Result<{
  product: ShopifyProductSnapshot;
  metafields: ShopifyMetafield[];
  variantMetafields: Map<string, ShopifyMetafield[]>;
  images: ShopifyProductImage[];
}>> {
  const base = deps.apiBase(store);
  const productResult = await pushRequest<{ product: ShopifyProductSnapshot }>(
    deps,
    `${base}/products/${encodeURIComponent(externalId)}.json`,
    token,
  );
  if (!productResult.ok) return productResult;
  const metafieldsResult = await pushRequest<{ metafields: ShopifyMetafield[] }>(
    deps,
    `${base}/products/${encodeURIComponent(externalId)}/metafields.json?namespace=${encodeURIComponent(PORULLE_METAFIELD_NAMESPACE)}`,
    token,
  );
  if (!metafieldsResult.ok) return metafieldsResult;
  const variantMetafields = new Map<string, ShopifyMetafield[]>();
  for (const variantId of variantIds) {
    const variantResult = await pushRequest<{ metafields: ShopifyMetafield[] }>(
      deps,
      `${base}/variants/${encodeURIComponent(variantId)}/metafields.json?namespace=${encodeURIComponent(PORULLE_METAFIELD_NAMESPACE)}`,
      token,
    );
    if (!variantResult.ok) return variantResult;
    variantMetafields.set(variantId, variantResult.data.metafields ?? []);
  }
  let images: ShopifyProductImage[] = [];
  if (withImages) {
    const imagesResult = await pushRequest<{ images: ShopifyProductImage[] }>(
      deps,
      `${base}/products/${encodeURIComponent(externalId)}/images.json`,
      token,
    );
    if (!imagesResult.ok) return imagesResult;
    images = imagesResult.data.images ?? [];
  }
  return Ok({
    product: productResult.data.product,
    metafields: metafieldsResult.data.metafields ?? [],
    variantMetafields,
    images,
  });
}

function shopifyId(externalId: string): number | string {
  return /^\d+$/.test(externalId) ? Number(externalId) : externalId;
}

function imageFileName(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function imageFileStem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// Shopify keeps the uploaded file name in the CDN path (suffixing `_<hash>` on a
// collision) but never echoes the original source URL, so a re-push without a
// recorded image id can only recognise its own image by that file name.
function matchExistingImage(
  image: ChannelPushCatalogImage,
  existing: ShopifyProductImage[],
): ShopifyProductImage | undefined {
  const externalId = image.externalId?.trim();
  if (externalId) return existing.find((candidate) => String(candidate.id) === externalId);
  const name = imageFileName(image.url);
  if (name === undefined) return undefined;
  const stem = imageFileStem(name);
  return existing.find((candidate) => {
    const candidateName = candidate.src ? imageFileName(candidate.src) : undefined;
    if (candidateName === undefined) return false;
    const candidateStem = imageFileStem(candidateName);
    return candidateName === name || candidateStem === stem || candidateStem.startsWith(`${stem}_`);
  });
}

function orderImages(images: ChannelPushCatalogImage[]): ChannelPushCatalogImage[] {
  const rank = (image: ChannelPushCatalogImage): number => (image.role === "primary" ? 0 : 1);
  return images
    .map((image, index) => ({ image, index }))
    .sort((left, right) =>
      rank(left.image) - rank(right.image)
      || (left.image.sortOrder ?? left.index) - (right.image.sortOrder ?? right.index)
      || left.index - right.index)
    .map((entry) => entry.image);
}

async function writeImages(
  deps: PushCatalogDeps,
  store: ChannelStore,
  token: string,
  externalId: string,
  images: ChannelPushCatalogImage[],
  existing: ShopifyProductImage[],
): Promise<{ outcomes: ChannelPushCatalogImageOutcome[]; error?: ChannelConnectorError }> {
  const outcomes: ChannelPushCatalogImageOutcome[] = [];
  const base = `${deps.apiBase(store)}/products/${encodeURIComponent(externalId)}/images`;
  const claimed = new Set<string>();
  for (const [index, image] of orderImages(images).entries()) {
    if (!SHOPIFY_IMAGE_ROLES.has(image.role)) {
      const error: ChannelConnectorError = {
        code: "SHOPIFY_IMAGE_ROLE_UNSUPPORTED",
        message: `Shopify product images cannot carry the "${image.role}" role.`,
        retriable: false,
      };
      outcomes.push({ url: image.url, role: image.role, ok: false, error });
      return { outcomes, error };
    }
    const match = matchExistingImage(image, existing.filter((candidate) => !claimed.has(String(candidate.id))));
    const payload: Record<string, unknown> = { position: index + 1 };
    if (image.alt !== undefined) payload.alt = image.alt;
    if (image.variantExternalIds && image.variantExternalIds.length > 0) {
      payload.variant_ids = image.variantExternalIds.map(shopifyId);
    }
    const result = match
      ? await pushRequest<{ image: ShopifyProductImage }>(deps, `${base}/${encodeURIComponent(String(match.id))}.json`, token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: { id: match.id, ...payload } }),
      })
      : await pushRequest<{ image: ShopifyProductImage }>(deps, `${base}.json`, token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: { src: image.url, ...payload } }),
      });
    if (!result.ok) {
      outcomes.push({ url: image.url, role: image.role, ok: false, error: result.error });
      return { outcomes, error: result.error };
    }
    const written = result.data.image ?? match;
    if (written) claimed.add(String(written.id));
    outcomes.push({
      url: image.url,
      role: image.role,
      ok: true,
      ...(written ? { externalId: String(written.id) } : {}),
    });
  }
  return { outcomes };
}

async function writeNativeProduct(
  deps: PushCatalogDeps,
  store: ChannelStore,
  token: string,
  externalId: string,
  fields: ChannelPushCatalogField[],
  tagValues: string[],
  existingTags: string[],
): Promise<PushRequestResponse<{ product: ShopifyProductSnapshot }>> {
  const product: Record<string, unknown> = { id: externalId };
  for (const field of fields) {
    if (!isNativeProductField(field)) continue;
    const key = remoteKey(field);
    if (key !== undefined) product[key] = field.value;
  }
  if (tagValues.length > 0) {
    product.tags = mergeTags(existingTags, tagValues);
  }
  if (Object.keys(product).length <= 1) {
    return {
      ok: true,
      data: { product: { id: externalId } },
      response: new Response(null, { status: 200 }),
    };
  }
  return pushRequest<{ product: ShopifyProductSnapshot }>(
    deps,
    `${deps.apiBase(store)}/products/${encodeURIComponent(externalId)}.json`,
    token,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product }),
    },
  );
}

async function writeVariantFields(
  deps: PushCatalogDeps,
  store: ChannelStore,
  token: string,
  variantExternalId: string,
  fields: ChannelPushCatalogField[],
): Promise<PushRequestResponse<{ variant: ShopifyVariantSnapshot }>> {
  const variant: Record<string, unknown> = { id: variantExternalId };
  for (const field of fields) {
    if (!isNativeVariantField(field)) continue;
    const key = remoteKey(field);
    if (key !== undefined) variant[key] = field.value;
  }
  if (Object.keys(variant).length <= 1) {
    return {
      ok: true,
      data: { variant: { id: variantExternalId } },
      response: new Response(null, { status: 200 }),
    };
  }
  return pushRequest<{ variant: ShopifyVariantSnapshot }>(
    deps,
    `${deps.apiBase(store)}/variants/${encodeURIComponent(variantExternalId)}.json`,
    token,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variant }),
    },
  );
}

async function writeMetafield(
  deps: PushCatalogDeps,
  store: ChannelStore,
  token: string,
  externalId: string,
  field: ChannelPushCatalogField,
  existing: ShopifyMetafield | undefined,
  resource: "product" | "variant",
): Promise<PushRequestResponse<{ metafield: ShopifyMetafield }>> {
  const key = remoteKey(field);
  if (key === undefined) return { ok: false, error: missingRemoteKeyError(field) };
  const payload = {
    metafield: {
      namespace: PORULLE_METAFIELD_NAMESPACE,
      key,
      value: metafieldValue(field.value),
      type: metafieldType(field.value),
    },
  };
  if (existing) {
    return pushRequest<{ metafield: ShopifyMetafield }>(
      deps,
      `${deps.apiBase(store)}/metafields/${encodeURIComponent(String(existing.id))}.json`,
      token,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }
  return pushRequest<{ metafield: ShopifyMetafield }>(
    deps,
    `${deps.apiBase(store)}/${resource}s/${encodeURIComponent(externalId)}/metafields.json`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

async function pushCatalogItem(
  deps: PushCatalogDeps,
  store: ChannelStore,
  token: string,
  item: ChannelPushCatalogItem,
  dryRun: boolean,
): Promise<ChannelPushCatalogItemOutcome> {
  const missingField = [...item.fields, ...(item.variants ?? []).flatMap((variant) => variant.fields)]
    .find((field) => field.intent !== "tag" && remoteKey(field) === undefined);
  if (missingField) return { externalId: item.externalId, ok: false, error: missingRemoteKeyError(missingField) };
  const images = item.images ?? [];
  const variantIds = (item.variants ?? [])
    .filter((variant) => variant.fields.some((field) => isMetafieldField(field)))
    .map((variant) => variant.externalId);
  const snapshot = await loadProductSnapshot(deps, store, token, item.externalId, variantIds, images.length > 0);
  if (!snapshot.ok) {
    return { externalId: item.externalId, ok: false, error: snapshot.error };
  }
  const previousFields = collectPreviousFields(snapshot.value.product, snapshot.value.metafields, snapshot.value.variantMetafields, item);
  if (dryRun) {
    return {
      externalId: item.externalId,
      ok: true,
      ...(previousFields.length > 0 ? { previousFields } : {}),
    };
  }

  const metafieldByKey = new Map(snapshot.value.metafields
    .filter((entry) => entry.namespace === PORULLE_METAFIELD_NAMESPACE)
    .map((entry) => [entry.key, entry]));
  const productFields = item.fields.filter((field) => field.intent !== "tag");
  const tagValues = item.fields
    .filter((field) => field.intent === "tag")
    .flatMap((field) => {
      if (typeof field.value === "string") return [field.value];
      if (Array.isArray(field.value)) return field.value.filter((entry): entry is string => typeof entry === "string");
      return field.value == null ? [] : [String(field.value)];
    });

  const nativeResult = await writeNativeProduct(
    deps,
    store,
    token,
    item.externalId,
    productFields,
    tagValues,
    parseTags(snapshot.value.product.tags),
  );
  if (!nativeResult.ok) {
    return { externalId: item.externalId, ok: false, error: nativeResult.error };
  }

  for (const field of productFields) {
    if (!isMetafieldField(field)) continue;
    const key = remoteKey(field);
    const metafieldResult = await writeMetafield(
      deps,
      store,
      token,
      item.externalId,
      field,
      key !== undefined ? metafieldByKey.get(key) : undefined,
      "product",
    );
    if (!metafieldResult.ok) {
      return { externalId: item.externalId, ok: false, error: metafieldResult.error };
    }
    if (metafieldResult.data.metafield) {
      metafieldByKey.set(metafieldResult.data.metafield.key, metafieldResult.data.metafield);
    }
  }

  for (const variant of item.variants ?? []) {
    const variantMetafieldByKey = new Map((snapshot.value.variantMetafields.get(variant.externalId) ?? [])
      .filter((entry) => entry.namespace === PORULLE_METAFIELD_NAMESPACE)
      .map((entry) => [entry.key, entry]));
    for (const field of variant.fields) {
      if (!isMetafieldField(field)) continue;
      const key = remoteKey(field);
      const metafieldResult = await writeMetafield(
        deps,
        store,
        token,
        variant.externalId,
        field,
        key !== undefined ? variantMetafieldByKey.get(key) : undefined,
        "variant",
      );
      if (!metafieldResult.ok) {
        return { externalId: item.externalId, ok: false, error: metafieldResult.error };
      }
      if (metafieldResult.data.metafield) {
        variantMetafieldByKey.set(metafieldResult.data.metafield.key, metafieldResult.data.metafield);
      }
    }
    const variantResult = await writeVariantFields(deps, store, token, variant.externalId, variant.fields);
    if (!variantResult.ok) {
      return { externalId: item.externalId, ok: false, error: variantResult.error };
    }
  }

  let imageOutcomes: ChannelPushCatalogImageOutcome[] | undefined;
  if (images.length > 0) {
    const imageResult = await writeImages(deps, store, token, item.externalId, images, snapshot.value.images);
    imageOutcomes = imageResult.outcomes;
    if (imageResult.error) {
      return { externalId: item.externalId, ok: false, error: imageResult.error, images: imageOutcomes };
    }
  }

  return {
    externalId: item.externalId,
    ok: true,
    ...(nativeResult.data.product.updated_at ? { remoteUpdatedAt: nativeResult.data.product.updated_at } : {}),
    ...(previousFields.length > 0 ? { previousFields } : {}),
    ...(imageOutcomes ? { images: imageOutcomes } : {}),
  };
}

export async function pushCatalog(
  deps: PushCatalogDeps,
  store: ChannelStore,
  items: ChannelPushCatalogItem[],
  opts?: { dryRun?: boolean; reauthorizeUrl?: string },
): Promise<Result<ChannelPushCatalogResult, ChannelConnectorError>> {
  const token = deps.credentials(store);
  if (!token) {
    return Err({ code: "SHOPIFY_CREDENTIALS_REQUIRED", message: "Shopify accessToken is required.", retriable: false });
  }
  if (!shopifyPushCatalogEnabled(store)) {
    return Err(shopifyWriteProductsScopeMissingError(opts?.reauthorizeUrl));
  }

  const outcomes: ChannelPushCatalogItemOutcome[] = [];
  for (const item of items) {
    outcomes.push(await pushCatalogItem(deps, store, token, item, opts?.dryRun === true));
  }
  return Ok({ outcomes });
}
