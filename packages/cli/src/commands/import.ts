import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
// @ts-ignore — missing type declarations
import { importFlat } from "@porulle/import-flat";
// @ts-ignore — missing type declarations
import { importShopifyCatalog } from "@porulle/import-shopify";
// @ts-ignore — missing type declarations
import { importWooCommerceCatalog } from "@porulle/import-woocommerce";

type JsonRecord = Record<string, unknown>;

function toBaseUrl(raw: string | undefined): string {
  return (raw ?? "http://localhost:3000").replace(/\/$/, "");
}

function toHeaders(token?: string): Record<string, string> {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...toHeaders(token),
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!response.ok) {
    const message = payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Request failed for ${method} ${path}: ${message}`);
  }

  if (payload.data === undefined) {
    throw new Error(`Expected data payload for ${method} ${path}.`);
  }

  return payload.data;
}

function createRestImportTarget(baseUrl: string, token?: string) {
  return {
    async createEntity(input: {
      type: string;
      slug: string;
      attributes: { title: string; description?: string; subtitle?: string; locale?: string };
      metadata?: Record<string, unknown>;
      customFields?: Record<string, unknown>;
    }) {
      return requestJson<{ id: string }>(baseUrl, "/api/catalog/entities", "POST", input, token);
    },
    async createOptionType(input: {
      entityId: string;
      name: string;
      displayName: string;
      sortOrder?: number;
    }) {
      return requestJson<{ id: string }>(
        baseUrl,
        `/api/catalog/entities/${input.entityId}/options`,
        "POST",
        input,
        token,
      );
    },
    async createOptionValue(input: {
      optionTypeId: string;
      value: string;
      displayValue: string;
      sortOrder?: number;
    }) {
      return requestJson<{ id: string }>(
        baseUrl,
        `/api/catalog/options/${input.optionTypeId}/values`,
        "POST",
        input,
        token,
      );
    },
    async createVariant(input: {
      entityId: string;
      optionValueIds: string[];
      sku?: string;
      barcode?: string;
      metadata?: Record<string, unknown>;
    }) {
      return requestJson<{ id: string }>(
        baseUrl,
        `/api/catalog/entities/${input.entityId}/variants`,
        "POST",
        input,
        token,
      );
    },
    async uploadMedia(input: {
      filename: string;
      contentType: string;
      data: ArrayBuffer;
      alt?: string;
      metadata?: Record<string, unknown>;
    }) {
      const form = new FormData();
      form.set(
        "file",
        new File([input.data], input.filename, {
          type: input.contentType,
        }),
      );
      if (input.alt) form.set("alt", input.alt);

      const response = await fetch(`${baseUrl}/api/media/upload`, {
        method: "POST",
        headers: {
          ...toHeaders(token),
        },
        body: form,
      });

      const payload = (await response.json().catch(() => ({}))) as {
        data?: { id: string; url: string };
        error?: { message?: string };
      };

      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? `Media upload failed (${response.status}).`);
      }

      return payload.data;
    },
    async attachMedia(input: { entityId: string; mediaAssetId: string; role: "primary" | "gallery" }) {
      await requestJson<{ attached: boolean }>(baseUrl, "/api/media/attach", "POST", input, token);
    },
  };
}

async function loadJsonInput(path: string): Promise<unknown> {
  const absolute = resolve(process.cwd(), path);
  const raw = await readFile(absolute, "utf8");
  return JSON.parse(raw) as unknown;
}

export const importCommand = defineCommand({
  meta: {
    name: "import",
    description: "Import catalog data from Shopify, WooCommerce, or flat CSV/JSON into UnifiedCommerce.",
  },
  args: {
    source: {
      type: "string",
      required: true,
      description: "shopify | woocommerce | flat",
    },
    input: {
      type: "string",
      description: "Path to input JSON/CSV for offline imports",
    },
    targetUrl: {
      type: "string",
      default: "http://localhost:3000",
      description: "UnifiedCommerce API base URL",
    },
    authToken: {
      type: "string",
      description: "Optional bearer token for target API",
    },
    apiKey: {
      type: "string",
      description: "Shopify admin API key/token",
    },
    storeUrl: {
      type: "string",
      description: "Shopify or WooCommerce store URL",
    },
    consumerKey: {
      type: "string",
      description: "WooCommerce consumer key",
    },
    consumerSecret: {
      type: "string",
      description: "WooCommerce consumer secret",
    },
    mapping: {
      type: "string",
      description: "Path to flat-import mapping JSON (required for source=flat)",
    },
    entityType: {
      type: "string",
      default: "product",
    },
  },
  async run({ args }) {
    const source = String(args.source).toLowerCase();
    const baseUrl = toBaseUrl(args.targetUrl ? String(args.targetUrl) : undefined);
    const token = args.authToken ? String(args.authToken) : undefined;
    const target = createRestImportTarget(baseUrl, token);

    if (source === "shopify") {
      let products: unknown;
      let customers: unknown;

      if (args.input) {
        const parsed = await loadJsonInput(String(args.input));
        if (Array.isArray(parsed)) {
          products = parsed;
        } else if (parsed && typeof parsed === "object") {
          products = (parsed as JsonRecord).products;
          customers = (parsed as JsonRecord).customers;
        }
      }

      const imported = await importShopifyCatalog({
        target,
        ...(args.storeUrl ? { storeUrl: String(args.storeUrl) } : {}),
        ...(args.apiKey ? { apiKey: String(args.apiKey) } : {}),
        entityType: String(args.entityType),
        ...(Array.isArray(products) ? { products: products as any[] } : {}),
        ...(Array.isArray(customers) ? { customers: customers as any[] } : {}),
      });

      if (!imported.ok) {
        throw new Error(imported.error.message);
      }

      consola.success(`Shopify import completed: ${imported.value.entitiesImported} entities, ${imported.value.variantsImported} variants, ${imported.value.mediaImported} media.`);
      if (imported.value.customersImported > 0) {
        consola.info(`Imported customers: ${imported.value.customersImported}`);
      }
      if (imported.value.errors.length > 0) {
        consola.warn(`Import completed with ${imported.value.errors.length} warnings.`);
      }
      return;
    }

    if (source === "woocommerce") {
      let products: unknown;
      let customers: unknown;

      if (args.input) {
        const parsed = await loadJsonInput(String(args.input));
        if (Array.isArray(parsed)) {
          products = parsed;
        } else if (parsed && typeof parsed === "object") {
          products = (parsed as JsonRecord).products;
          customers = (parsed as JsonRecord).customers;
        }
      }

      const imported = await importWooCommerceCatalog({
        target,
        ...(args.storeUrl ? { storeUrl: String(args.storeUrl) } : {}),
        ...(args.consumerKey ? { consumerKey: String(args.consumerKey) } : {}),
        ...(args.consumerSecret ? { consumerSecret: String(args.consumerSecret) } : {}),
        entityType: String(args.entityType),
        ...(Array.isArray(products) ? { products: products as any[] } : {}),
        ...(Array.isArray(customers) ? { customers: customers as any[] } : {}),
      });

      if (!imported.ok) {
        throw new Error(imported.error.message);
      }

      consola.success(`WooCommerce import completed: ${imported.value.entitiesImported} entities, ${imported.value.variantsImported} variants, ${imported.value.mediaImported} media.`);
      if (imported.value.customersImported > 0) {
        consola.info(`Imported customers: ${imported.value.customersImported}`);
      }
      if (imported.value.errors.length > 0) {
        consola.warn(`Import completed with ${imported.value.errors.length} warnings.`);
      }
      return;
    }

    if (source === "flat") {
      if (!args.mapping) {
        throw new Error("--mapping is required for source=flat");
      }

      const mappingParsed = await loadJsonInput(String(args.mapping));
      if (!mappingParsed || typeof mappingParsed !== "object") {
        throw new Error("Flat import mapping file must be a JSON object.");
      }

      if (!args.input) {
        throw new Error("--input is required for source=flat");
      }

      const inputPath = resolve(process.cwd(), String(args.input));
      const raw = await readFile(inputPath, "utf8");
      const extension = extname(inputPath).toLowerCase();

      const imported = await importFlat({
        mapping: mappingParsed as any,
        target: {
          async createEntity(input: unknown) {
            return target.createEntity(input as Parameters<typeof target.createEntity>[0]);
          },
        },
        ...(extension === ".csv" ? { csv: raw } : { json: raw }),
      });

      if (!imported.ok) {
        throw new Error(imported.error.message);
      }

      consola.success(`Flat import completed: ${imported.value.imported} entities imported.`);
      if (imported.value.failed > 0) {
        consola.warn(`Failed rows: ${imported.value.failed}`);
      }
      return;
    }

    throw new Error(`Unsupported source: ${source}. Expected shopify, woocommerce, or flat.`);
  },
});
