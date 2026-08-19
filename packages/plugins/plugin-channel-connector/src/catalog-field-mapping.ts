import type { FieldPath } from "@porulle/core";

export const catalogFieldTargets = ["native", "attribute", "meta"] as const;
export type CatalogFieldTarget = (typeof catalogFieldTargets)[number];

export interface CatalogFieldMappingRow {
  fieldPath: FieldPath;
  provider: string;
  target: CatalogFieldTarget;
  remoteKey: string;
}

export type CatalogFieldMapping = CatalogFieldMappingRow[];

export type CatalogFieldMappingInput =
  | Array<{ fieldPath: string; provider?: string; target: CatalogFieldTarget; remoteKey: string }>
  | Record<string, { provider?: string; target: CatalogFieldTarget; remoteKey: string }>;

const fieldSegment = /^[A-Za-z0-9_-]+$/;
const forbiddenFieldPaths = ["variants.sku", "variants.barcode", "options", "prices", "entity.status"];

export const providerCatalogFieldMappingDefaults: Record<string, CatalogFieldMapping> = {
  shopify: [
    { fieldPath: "attributes.*.title", provider: "shopify", target: "native", remoteKey: "title" },
    { fieldPath: "attributes.*.description", provider: "shopify", target: "native", remoteKey: "body_html" },
    { fieldPath: "attributes.*.seoTitle", provider: "shopify", target: "meta", remoteKey: "seo_title" },
    { fieldPath: "attributes.*.seoDescription", provider: "shopify", target: "meta", remoteKey: "seo_description" },
    { fieldPath: "customFields.*.*", provider: "shopify", target: "meta", remoteKey: "metafields" },
    { fieldPath: "media.*", provider: "shopify", target: "native", remoteKey: "images" },
    { fieldPath: "entity.metadata.*", provider: "shopify", target: "meta", remoteKey: "metafields" },
  ],
  woocommerce: [
    { fieldPath: "attributes.*.title", provider: "woocommerce", target: "native", remoteKey: "name" },
    { fieldPath: "attributes.*.description", provider: "woocommerce", target: "native", remoteKey: "description" },
    { fieldPath: "attributes.*.seoTitle", provider: "woocommerce", target: "meta", remoteKey: "yoast_wpseo_title" },
    { fieldPath: "attributes.*.seoDescription", provider: "woocommerce", target: "meta", remoteKey: "yoast_wpseo_metadesc" },
    { fieldPath: "customFields.*.*", provider: "woocommerce", target: "meta", remoteKey: "porulle_meta_data" },
    { fieldPath: "media.*", provider: "woocommerce", target: "native", remoteKey: "images" },
    { fieldPath: "entity.metadata.*", provider: "woocommerce", target: "meta", remoteKey: "porulle_meta_data" },
  ],
};

export function matchFieldPath(pattern: string, path: string): boolean {
  const patternSegments = pattern.split(".");
  const pathSegments = path.split(".");
  return patternSegments.length === pathSegments.length
    && patternSegments.every((segment, index) => pathSegments[index] !== "" && (segment === "*" || segment === pathSegments[index]));
}

export function isValidCatalogMappingFieldPath(value: string): boolean {
  const segments = value.split(".");
  return segments.length > 0 && segments.every((segment) => segment === "*" || fieldSegment.test(segment));
}

function couldCoverForbiddenSubtree(fieldPath: string, root: string): boolean {
  const fieldSegments = fieldPath.split(".");
  const rootSegments = root.split(".");
  return fieldSegments.length >= rootSegments.length
    && rootSegments.every((segment, index) => fieldSegments[index] === "*" || fieldSegments[index] === segment);
}

function isForbiddenMappingFieldPath(fieldPath: string): boolean {
  return forbiddenFieldPaths.some((root) => couldCoverForbiddenSubtree(fieldPath, root));
}

export function validateCatalogMappingRow(
  input: Partial<CatalogFieldMappingRow> & { fieldPath: string; target: CatalogFieldTarget; remoteKey: string },
  provider: string,
): CatalogFieldMappingRow {
  if (!isValidCatalogMappingFieldPath(input.fieldPath)) {
    throw new Error("Catalog mapping field paths must contain dot-separated alphanumeric, underscore, hyphen, or wildcard segments.");
  }
  if (isForbiddenMappingFieldPath(input.fieldPath)) {
    throw new Error(`Catalog mapping cannot write the forbidden field path "${input.fieldPath}".`);
  }
  if (!catalogFieldTargets.includes(input.target)) {
    throw new Error(`Catalog mapping target "${input.target}" is invalid.`);
  }
  const remoteKey = input.remoteKey.trim();
  if (remoteKey.length === 0) {
    throw new Error("Catalog mapping remoteKey must not be empty.");
  }
  const rowProvider = input.provider ?? provider;
  if (rowProvider !== provider) {
    throw new Error(`Catalog mapping provider must be "${provider}" for this store.`);
  }
  if (rowProvider === "woocommerce" && input.target === "meta" && remoteKey.startsWith("_")) {
    throw new Error("WooCommerce meta keys must not start with an underscore.");
  }
  return {
    fieldPath: input.fieldPath,
    provider: rowProvider,
    target: input.target,
    remoteKey,
  };
}

function mappingEntries(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") throw new Error("Catalog mapping must be an array or an object.");
  return Object.entries(input).map(([fieldPath, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Catalog mapping values must be objects.");
    return { ...(value as Record<string, unknown>), fieldPath };
  });
}

function normalizeCatalogMappingRow(row: unknown, provider: string): CatalogFieldMappingRow {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Catalog mapping rows must be objects.");
  const value = row as Record<string, unknown>;
  if (typeof value.fieldPath !== "string" || typeof value.target !== "string" || typeof value.remoteKey !== "string") {
    throw new Error("Catalog mapping rows require fieldPath, target, and remoteKey.");
  }
  return validateCatalogMappingRow(
    {
      fieldPath: value.fieldPath,
      ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
      target: value.target as CatalogFieldTarget,
      remoteKey: value.remoteKey,
    },
    provider,
  );
}

export function normalizeCatalogFieldMapping(input: unknown, provider: string): CatalogFieldMapping {
  return mappingEntries(input).map((row) => normalizeCatalogMappingRow(row, provider));
}

function normalizeStoredCatalogFieldMapping(input: unknown, provider: string, warnings: string[]): CatalogFieldMapping {
  let entries: unknown[];
  try {
    entries = mappingEntries(input ?? []);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "Stored catalog mapping is invalid.");
    return [];
  }
  return entries.flatMap((row, index) => {
    try {
      return [normalizeCatalogMappingRow(row, provider)];
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stored catalog mapping row is invalid.";
      warnings.push(`Skipped catalog mapping row ${index}: ${message}`);
      return [];
    }
  });
}

function filterableEntries(hint: ReadonlySet<string> | Readonly<Record<string, boolean>>): Array<[string, boolean]> {
  if (hint instanceof Set) return [...hint].map((path) => [path, true]);
  return Object.entries(hint);
}

export function mergeCatalogFieldMapping(
  provider: string,
  overrides: unknown,
  filterableCustomFields?: ReadonlySet<string> | Readonly<Record<string, boolean>>,
  warnings: string[] = [],
): CatalogFieldMapping {
  const defaults = (providerCatalogFieldMappingDefaults[provider] ?? []).map((row) => ({ ...row }));
  const rows = normalizeStoredCatalogFieldMapping(overrides, provider, warnings);
  const merged = [...defaults];
  for (const row of rows) {
    const index = merged.findIndex((defaultRow) => defaultRow.fieldPath === row.fieldPath && defaultRow.provider === row.provider);
    if (index === -1) merged.push(row);
    else merged[index] = row;
  }
  if (!filterableCustomFields) return merged;
  const hints = filterableEntries(filterableCustomFields).filter(([path]) => isValidCatalogMappingFieldPath(path));
  if (hints.length === 0) return merged;
  const customFieldPattern = "customFields.*.*";
  const customFieldDefault = merged.find((row) => row.fieldPath === customFieldPattern);
  if (!customFieldDefault) return merged;
  const expanded = hints
    .filter(([path]) => matchFieldPath(customFieldPattern, path))
    .map(([fieldPath, filterable]) => ({
      ...customFieldDefault,
      fieldPath,
      target: filterable ? "attribute" as const : "meta" as const,
      remoteKey: fieldPath.split(".")[1] ?? customFieldDefault.remoteKey,
    }));
  return [...merged.filter((row) => row.fieldPath !== customFieldPattern), ...expanded];
}

function wildcardCount(fieldPath: string): number {
  return fieldPath.split(".").filter((segment) => segment === "*").length;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareCatalogFieldMappingSpecificity(
  left: CatalogFieldMappingRow,
  right: CatalogFieldMappingRow,
): number {
  const wildcardDifference = wildcardCount(left.fieldPath) - wildcardCount(right.fieldPath);
  if (wildcardDifference !== 0) return wildcardDifference;
  const fieldPathDifference = compareStrings(left.fieldPath, right.fieldPath);
  if (fieldPathDifference !== 0) return fieldPathDifference;
  const providerDifference = compareStrings(left.provider, right.provider);
  if (providerDifference !== 0) return providerDifference;
  return compareStrings(left.remoteKey, right.remoteKey);
}

export function selectCatalogFieldMapping(
  mapping: CatalogFieldMapping,
  path: string,
): CatalogFieldMappingRow | undefined {
  return mapping.filter((row) => matchFieldPath(row.fieldPath, path)).sort(compareCatalogFieldMappingSpecificity)[0];
}
