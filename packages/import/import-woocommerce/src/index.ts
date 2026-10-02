import { Err, Ok, toMinorUnits, type Result } from "@porulle/core";

export interface WooImage {
  id: number;
  src: string;
  alt?: string;
}

export interface WooAttribute {
  id?: number;
  name: string;
  variation?: boolean;
  options?: string[];
  option?: string;
}

export interface WooProductVariation {
  id: number;
  sku?: string;
  price?: string;
  attributes?: WooAttribute[];
}

export interface WooProduct {
  id: number;
  name: string;
  slug?: string;
  description?: string;
  short_description?: string;
  type?: string;
  sku?: string;
  categories?: Array<{ id: number; name: string; slug?: string }>;
  attributes?: WooAttribute[];
  images?: WooImage[];
  variationsData?: WooProductVariation[];
}

export interface WooCustomer {
  id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  billing?: {
    phone?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  shipping?: {
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
}

export interface WooImportTarget {
  createEntity(input: {
    type: string;
    slug: string;
    attributes: { title: string; description?: string; subtitle?: string };
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  createOptionType?(input: {
    entityId: string;
    name: string;
    displayName: string;
    sortOrder?: number;
  }): Promise<{ id: string }>;
  createOptionValue?(input: {
    optionTypeId: string;
    value: string;
    displayValue: string;
    sortOrder?: number;
  }): Promise<{ id: string }>;
  createVariant?(input: {
    entityId: string;
    optionValueIds: string[];
    sku?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }>;
  uploadMedia?(input: {
    filename: string;
    contentType: string;
    data: ArrayBuffer;
    alt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; url: string }>;
  attachMedia?(input: {
    entityId: string;
    mediaAssetId: string;
    role: "primary" | "gallery";
  }): Promise<void>;
  upsertCustomer?(input: {
    userId: string;
    email?: string;
    phone?: string;
    firstName?: string;
    lastName?: string;
    addresses?: Array<{
      type: "shipping" | "billing";
      isDefault: boolean;
      firstName: string;
      lastName: string;
      line1: string;
      line2?: string;
      city: string;
      state?: string;
      postalCode?: string;
      country: string;
      phone?: string;
    }>;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface WooImportOptions {
  target: WooImportTarget;
  storeUrl?: string;
  consumerKey?: string;
  consumerSecret?: string;
  products?: WooProduct[];
  customers?: WooCustomer[];
  currency?: string;
  fetchImpl?: typeof fetch;
  mediaFetcher?: (url: string) => Promise<{ data: ArrayBuffer; contentType: string; filename?: string }>;
  entityType?: string;
}

export interface WooImportSummary {
  entitiesImported: number;
  variantsImported: number;
  mediaImported: number;
  customersImported: number;
  errors: Array<{ scope: "entity" | "variant" | "media" | "customer"; message: string }>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `product-${crypto.randomUUID().slice(0, 8)}`;
}

function buildWooUrl(base: string, path: string, key: string, secret: string, page = 1): string {
  const url = new URL(path, base.replace(/\/$/, "/"));
  url.searchParams.set("consumer_key", key);
  url.searchParams.set("consumer_secret", secret);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  return url.toString();
}

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toUpperCase();
}

function settingCurrency(data: unknown): string | undefined {
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      const setting = entry as Record<string, unknown>;
      if (setting.id === "woocommerce_currency") return normalizeCurrency(setting.value);
    }
  }
  if (typeof data !== "object" || data === null) return undefined;
  const object = data as Record<string, unknown>;
  return normalizeCurrency(object.woocommerce_currency);
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
): Promise<Result<{ data: T; response: Response }>> {
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return Err({
        code: "WOO_API_FAILED",
        message: `WooCommerce request failed (${response.status}) for ${url}.`,
      });
    }
    return Ok({ data: (await response.json()) as T, response });
  } catch (error) {
    return Err({
      code: "WOO_API_FAILED",
      message: error instanceof Error ? error.message : "WooCommerce request failed.",
    });
  }
}

function totalPages(response: Response): number | undefined {
  const value = Number.parseInt(response.headers.get("x-wp-totalpages") ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function loadProducts(options: WooImportOptions): Promise<Result<WooProduct[]>> {
  if (options.products) return Ok(options.products);
  if (!options.storeUrl || !options.consumerKey || !options.consumerSecret) {
    return Err({
      code: "WOO_INPUT_REQUIRED",
      message: "Provide products or storeUrl + consumerKey + consumerSecret.",
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const products: WooProduct[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchJson<WooProduct[]>(
      fetchImpl,
      buildWooUrl(options.storeUrl, "/wp-json/wc/v3/products", options.consumerKey, options.consumerSecret, page),
    );
    if (!response.ok) return response;
    products.push(...response.value.data);
    if (response.value.data.length === 0 || (totalPages(response.value.response) ?? Number.POSITIVE_INFINITY) <= page) {
      break;
    }
  }
  return Ok(products);
}

async function loadCustomers(options: WooImportOptions): Promise<Result<WooCustomer[]>> {
  if (options.customers) return Ok(options.customers);
  if (!options.storeUrl || !options.consumerKey || !options.consumerSecret) {
    return Ok([]);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const customers: WooCustomer[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchJson<WooCustomer[]>(
      fetchImpl,
      buildWooUrl(options.storeUrl, "/wp-json/wc/v3/customers", options.consumerKey, options.consumerSecret, page),
    );
    if (!response.ok) return response;
    customers.push(...response.value.data);
    if (response.value.data.length === 0 || (totalPages(response.value.response) ?? Number.POSITIVE_INFINITY) <= page) {
      break;
    }
  }
  return Ok(customers);
}

async function loadCurrency(options: WooImportOptions): Promise<string | undefined> {
  const configured = normalizeCurrency(options.currency);
  if (configured) return configured;
  if (!options.storeUrl || !options.consumerKey || !options.consumerSecret) return undefined;
  const response = await fetchJson<unknown>(
    options.fetchImpl ?? fetch,
    buildWooUrl(options.storeUrl, "/wp-json/wc/v3/settings/general", options.consumerKey, options.consumerSecret),
  );
  return response.ok ? settingCurrency(response.value.data) : undefined;
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop() ?? `media-${crypto.randomUUID().slice(0, 8)}.bin`;
  } catch {
    return `media-${crypto.randomUUID().slice(0, 8)}.bin`;
  }
}

async function defaultMediaFetcher(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ data: ArrayBuffer; contentType: string; filename: string }> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media (${response.status}) from ${url}`);
  }

  return {
    data: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    filename: filenameFromUrl(url),
  };
}

export async function importWooCommerceCatalog(options: WooImportOptions): Promise<Result<WooImportSummary>> {
  const products = await loadProducts(options);
  if (!products.ok) return products;

  const customers = await loadCustomers(options);
  if (!customers.ok) return customers;
  const currency = await loadCurrency(options);

  const summary: WooImportSummary = {
    entitiesImported: 0,
    variantsImported: 0,
    mediaImported: 0,
    customersImported: 0,
    errors: [],
  };

  const mediaFetcher = options.mediaFetcher
    ? options.mediaFetcher
    : async (url: string) => defaultMediaFetcher(options.fetchImpl ?? fetch, url);

  for (const product of products.value) {
    try {
      const createdEntity = await options.target.createEntity({
        type: options.entityType ?? "product",
        slug: product.slug ? slugify(product.slug) : slugify(product.name),
        attributes: {
          title: product.name,
          ...(product.description ? { description: product.description } : {}),
          ...(product.short_description ? { subtitle: product.short_description } : {}),
        },
        metadata: {
          source: "woocommerce",
          wooProductId: product.id,
          productType: product.type,
          categories: (product.categories ?? []).map((category) => category.slug ?? category.name),
        },
      });

      summary.entitiesImported += 1;

      const optionTypeIdByName = new Map<string, string>();
      const optionValueIdByKey = new Map<string, string>();

      if (options.target.createOptionType && options.target.createOptionValue) {
        const attributes = (product.attributes ?? []).filter((attribute) => attribute.variation);
        for (let attrIndex = 0; attrIndex < attributes.length; attrIndex += 1) {
          const attribute = attributes[attrIndex]!;
          const createdType = await options.target.createOptionType({
            entityId: createdEntity.id,
            name: attribute.name,
            displayName: attribute.name,
            sortOrder: attrIndex,
          });
          optionTypeIdByName.set(attribute.name, createdType.id);

          for (let valueIndex = 0; valueIndex < (attribute.options ?? []).length; valueIndex += 1) {
            const value = attribute.options![valueIndex]!;
            const createdValue = await options.target.createOptionValue({
              optionTypeId: createdType.id,
              value,
              displayValue: value,
              sortOrder: valueIndex,
            });
            optionValueIdByKey.set(`${attribute.name}::${value}`, createdValue.id);
          }
        }
      }

      if (options.target.createVariant) {
        const variationData = product.variationsData ?? [];
        for (const variant of variationData) {
          try {
            // An unknown store currency falls back to two decimals.
            const price = toMinorUnits(variant.price, currency ?? "");
            const optionValueIds = (variant.attributes ?? [])
              .map((attribute) => optionValueIdByKey.get(`${attribute.name}::${attribute.option ?? ""}`))
              .filter((value): value is string => typeof value === "string");

            await options.target.createVariant({
              entityId: createdEntity.id,
              optionValueIds,
              ...(variant.sku ? { sku: variant.sku } : {}),
              metadata: {
                source: "woocommerce",
                wooVariationId: variant.id,
                ...(price !== undefined ? { price } : {}),
              },
            });

            summary.variantsImported += 1;
          } catch (error) {
            summary.errors.push({
              scope: "variant",
              message: error instanceof Error ? error.message : "Variation import failed.",
            });
          }
        }
      }

      if (options.target.uploadMedia && options.target.attachMedia) {
        for (let imageIndex = 0; imageIndex < (product.images ?? []).length; imageIndex += 1) {
          const image = product.images![imageIndex]!;

          try {
            const downloaded = await mediaFetcher(image.src);
            const uploaded = await options.target.uploadMedia({
              filename: downloaded.filename ?? filenameFromUrl(image.src),
              contentType: downloaded.contentType,
              data: downloaded.data,
              ...(image.alt ? { alt: image.alt } : {}),
              metadata: {
                source: "woocommerce",
                wooImageId: image.id,
              },
            });
            await options.target.attachMedia({
              entityId: createdEntity.id,
              mediaAssetId: uploaded.id,
              role: imageIndex === 0 ? "primary" : "gallery",
            });
            summary.mediaImported += 1;
          } catch (error) {
            summary.errors.push({
              scope: "media",
              message: error instanceof Error ? error.message : "Media import failed.",
            });
          }
        }
      }
    } catch (error) {
      summary.errors.push({
        scope: "entity",
        message: error instanceof Error ? error.message : "Entity import failed.",
      });
    }
  }

  if (options.target.upsertCustomer) {
    for (const customer of customers.value) {
      try {
        const billing = customer.billing;
        const shipping = customer.shipping;

        const addresses: Array<{
          type: "shipping" | "billing";
          isDefault: boolean;
          firstName: string;
          lastName: string;
          line1: string;
          line2?: string;
          city: string;
          state?: string;
          postalCode?: string;
          country: string;
          phone?: string;
        }> = [];

        if (billing?.address_1) {
          addresses.push({
            type: "billing",
            isDefault: true,
            firstName: customer.first_name ?? "",
            lastName: customer.last_name ?? "",
            line1: billing.address_1,
            ...(billing.address_2 ? { line2: billing.address_2 } : {}),
            city: billing.city ?? "",
            ...(billing.state ? { state: billing.state } : {}),
            ...(billing.postcode ? { postalCode: billing.postcode } : {}),
            country: billing.country ?? "US",
            ...(billing.phone ? { phone: billing.phone } : {}),
          });
        }

        if (shipping?.address_1) {
          addresses.push({
            type: "shipping",
            isDefault: addresses.length === 0,
            firstName: customer.first_name ?? "",
            lastName: customer.last_name ?? "",
            line1: shipping.address_1,
            ...(shipping.address_2 ? { line2: shipping.address_2 } : {}),
            city: shipping.city ?? "",
            ...(shipping.state ? { state: shipping.state } : {}),
            ...(shipping.postcode ? { postalCode: shipping.postcode } : {}),
            country: shipping.country ?? "US",
          });
        }

        await options.target.upsertCustomer({
          userId: `woocommerce:${customer.id}`,
          ...(customer.email ? { email: customer.email } : {}),
          ...(billing?.phone ? { phone: billing.phone } : {}),
          ...(customer.first_name ? { firstName: customer.first_name } : {}),
          ...(customer.last_name ? { lastName: customer.last_name } : {}),
          addresses,
          metadata: {
            source: "woocommerce",
            wooCustomerId: customer.id,
          },
        });

        summary.customersImported += 1;
      } catch (error) {
        summary.errors.push({
          scope: "customer",
          message: error instanceof Error ? error.message : "Customer import failed.",
        });
      }
    }
  }

  return Ok(summary);
}
