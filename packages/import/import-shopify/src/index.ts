import { Err, Ok, type Result } from "@porulle/core";

export interface ShopifyImage {
  id: number;
  src: string;
  alt?: string | null;
}

export interface ShopifyProductOption {
  id?: number;
  name: string;
  position?: number;
  values: string[];
}

export interface ShopifyVariant {
  id: number;
  title?: string;
  sku?: string;
  barcode?: string;
  price?: string;
  compare_at_price?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle?: string;
  body_html?: string;
  product_type?: string;
  vendor?: string;
  tags?: string;
  options?: ShopifyProductOption[];
  variants?: ShopifyVariant[];
  images?: ShopifyImage[];
}

export interface ShopifyAddress {
  first_name?: string;
  last_name?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country_code?: string;
  phone?: string;
  default?: boolean;
}

export interface ShopifyCustomer {
  id: number;
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  addresses?: ShopifyAddress[];
}

export interface ShopifyImportTarget {
  createEntity(input: {
    type: string;
    slug: string;
    attributes: { title: string; description?: string };
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
    barcode?: string;
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

export interface ShopifyImportOptions {
  target: ShopifyImportTarget;
  apiKey?: string;
  storeUrl?: string;
  apiVersion?: string;
  products?: ShopifyProduct[];
  customers?: ShopifyCustomer[];
  fetchImpl?: typeof fetch;
  mediaFetcher?: (url: string) => Promise<{ data: ArrayBuffer; contentType: string; filename?: string }>;
  entityType?: string;
}

export interface ShopifyImportSummary {
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

function parseMoney(value: string | undefined | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
): Promise<Result<T>> {
  try {
    const response = await fetchImpl(url, {
      headers: {
        "x-shopify-access-token": apiKey,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return Err({
        code: "SHOPIFY_API_FAILED",
        message: `Shopify API request failed (${response.status}) for ${url}.`,
      });
    }

    return Ok((await response.json()) as T);
  } catch (error) {
    return Err({
      code: "SHOPIFY_API_FAILED",
      message: error instanceof Error ? error.message : "Shopify API request failed.",
    });
  }
}

function filenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last && last.length > 0 ? last : `media-${crypto.randomUUID().slice(0, 8)}.bin`;
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
    throw new Error(`Failed to download media (${response.status}) from ${url}`);
  }

  return {
    data: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    filename: filenameFromUrl(url),
  };
}

async function loadProducts(options: ShopifyImportOptions): Promise<Result<ShopifyProduct[]>> {
  if (options.products) return Ok(options.products);

  if (!options.storeUrl || !options.apiKey) {
    return Err({
      code: "SHOPIFY_INPUT_REQUIRED",
      message: "Provide products or both storeUrl and apiKey for Shopify import.",
    });
  }

  const base = options.storeUrl.replace(/\/$/, "");
  const version = options.apiVersion ?? "2024-10";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchJson<{ products: ShopifyProduct[] }>(
    fetchImpl,
    `${base}/admin/api/${version}/products.json?limit=250`,
    options.apiKey,
  );

  if (!response.ok) return response;
  return Ok(response.value.products ?? []);
}

async function loadCustomers(options: ShopifyImportOptions): Promise<Result<ShopifyCustomer[]>> {
  if (options.customers) return Ok(options.customers);

  if (!options.storeUrl || !options.apiKey) {
    return Ok([]);
  }

  const base = options.storeUrl.replace(/\/$/, "");
  const version = options.apiVersion ?? "2024-10";
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchJson<{ customers: ShopifyCustomer[] }>(
    fetchImpl,
    `${base}/admin/api/${version}/customers.json?limit=250`,
    options.apiKey,
  );

  if (!response.ok) return response;
  return Ok(response.value.customers ?? []);
}

function toAddress(address: ShopifyAddress): {
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
} {
  return {
    type: "shipping",
    isDefault: address.default ?? false,
    firstName: address.first_name ?? "",
    lastName: address.last_name ?? "",
    line1: address.address1 ?? "",
    ...(address.address2 ? { line2: address.address2 } : {}),
    city: address.city ?? "",
    ...(address.province ? { state: address.province } : {}),
    ...(address.zip ? { postalCode: address.zip } : {}),
    country: address.country_code ?? "US",
    ...(address.phone ? { phone: address.phone } : {}),
  };
}

export async function importShopifyCatalog(options: ShopifyImportOptions): Promise<Result<ShopifyImportSummary>> {
  const productsResult = await loadProducts(options);
  if (!productsResult.ok) return productsResult;

  const customersResult = await loadCustomers(options);
  if (!customersResult.ok) return customersResult;

  const summary: ShopifyImportSummary = {
    entitiesImported: 0,
    variantsImported: 0,
    mediaImported: 0,
    customersImported: 0,
    errors: [],
  };

  const mediaFetcher = options.mediaFetcher
    ? options.mediaFetcher
    : async (url: string) => defaultMediaFetcher(options.fetchImpl ?? fetch, url);

  for (const product of productsResult.value) {
    try {
      const createdEntity = await options.target.createEntity({
        type: options.entityType ?? "product",
        slug: product.handle ? slugify(product.handle) : slugify(product.title),
        attributes: {
          title: product.title,
          ...(product.body_html ? { description: product.body_html } : {}),
        },
        metadata: {
          source: "shopify",
          shopifyProductId: product.id,
          productType: product.product_type,
          vendor: product.vendor,
          tags: product.tags,
        },
      });

      summary.entitiesImported += 1;

      const optionTypeIdByName = new Map<string, string>();
      const optionValueIdByKey = new Map<string, string>();

      if (options.target.createOptionType && options.target.createOptionValue) {
        const optionList = product.options ?? [];
        for (let optionIndex = 0; optionIndex < optionList.length; optionIndex += 1) {
          const option = optionList[optionIndex]!;
          const createdType = await options.target.createOptionType({
            entityId: createdEntity.id,
            name: option.name,
            displayName: option.name,
            sortOrder: option.position ?? optionIndex,
          });
          optionTypeIdByName.set(option.name, createdType.id);

          for (let valueIndex = 0; valueIndex < option.values.length; valueIndex += 1) {
            const value = option.values[valueIndex]!;
            const createdValue = await options.target.createOptionValue({
              optionTypeId: createdType.id,
              value,
              displayValue: value,
              sortOrder: valueIndex,
            });
            optionValueIdByKey.set(`${option.name}::${value}`, createdValue.id);
          }
        }
      }

      if (options.target.createVariant && (product.variants?.length ?? 0) > 0) {
        for (const variant of product.variants ?? []) {
          try {
            const optionValues: string[] = [];
            const selectors = [variant.option1, variant.option2, variant.option3];
            const productOptions = product.options ?? [];

            for (let idx = 0; idx < selectors.length; idx += 1) {
              const selected = selectors[idx];
              if (!selected) continue;
              const optionName = productOptions[idx]?.name;
              if (!optionName) continue;
              const optionValueId = optionValueIdByKey.get(`${optionName}::${selected}`);
              if (optionValueId) {
                optionValues.push(optionValueId);
              }
            }

            await options.target.createVariant({
              entityId: createdEntity.id,
              optionValueIds: optionValues,
              ...(variant.sku ? { sku: variant.sku } : {}),
              ...(variant.barcode ? { barcode: variant.barcode } : {}),
              metadata: {
                source: "shopify",
                shopifyVariantId: variant.id,
                title: variant.title,
                price: parseMoney(variant.price),
                compareAtPrice: parseMoney(variant.compare_at_price),
              },
            });

            summary.variantsImported += 1;
          } catch (error) {
            summary.errors.push({
              scope: "variant",
              message: error instanceof Error ? error.message : "Variant import failed.",
            });
          }
        }
      }

      if (options.target.uploadMedia && options.target.attachMedia) {
        const images = product.images ?? [];
        for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
          const image = images[imageIndex]!;

          try {
            const downloaded = await mediaFetcher(image.src);
            const uploaded = await options.target.uploadMedia({
              filename: downloaded.filename ?? filenameFromUrl(image.src),
              contentType: downloaded.contentType,
              data: downloaded.data,
              ...(image.alt ? { alt: image.alt } : {}),
              metadata: {
                source: "shopify",
                shopifyImageId: image.id,
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
    for (const customer of customersResult.value) {
      try {
        await options.target.upsertCustomer({
          userId: `shopify:${customer.id}`,
          ...(customer.email ? { email: customer.email } : {}),
          ...(customer.phone ? { phone: customer.phone } : {}),
          ...(customer.first_name ? { firstName: customer.first_name } : {}),
          ...(customer.last_name ? { lastName: customer.last_name } : {}),
          addresses: (customer.addresses ?? []).map((address) => toAddress(address)),
          metadata: {
            source: "shopify",
            shopifyCustomerId: customer.id,
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
