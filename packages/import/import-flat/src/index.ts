import { Err, Ok, type Result } from "@porulle/core";

export interface FlatImportEntityInput {
  type: string;
  slug: string;
  attributes: {
    locale?: string;
    title: string;
    description?: string;
    subtitle?: string;
  };
  metadata?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
}

export interface FlatImportTarget {
  createEntity(input: FlatImportEntityInput): Promise<{ id: string }>;
}

export type FlatValueResolver = string | ((row: Record<string, string>) => unknown);

export interface FlatImportMapping {
  entityType: string;
  slug: FlatValueResolver;
  title: FlatValueResolver;
  description?: FlatValueResolver;
  subtitle?: FlatValueResolver;
  locale?: string;
  metadata?: Record<string, FlatValueResolver>;
  customFields?: Record<string, FlatValueResolver>;
}

export interface ImportFlatOptions {
  mapping: FlatImportMapping;
  target: FlatImportTarget;
  rows?: Array<Record<string, string>>;
  csv?: string;
  json?: string;
  delimiter?: string;
}

export interface ImportFlatSummary {
  imported: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
  entityIds: string[];
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const output: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      output.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  output.push(current.trim());
  return output;
}

export function parseCsv(input: string, delimiter = ","): Array<Record<string, string>> {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]!, delimiter);
  const rows: Array<Record<string, string>> = [];

  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line, delimiter);
    const row: Record<string, string> = {};

    for (let i = 0; i < headers.length; i += 1) {
      const key = headers[i];
      if (!key) continue;
      row[key] = values[i] ?? "";
    }

    rows.push(row);
  }

  return rows;
}

function resolveValue(row: Record<string, string>, resolver: FlatValueResolver | undefined): unknown {
  if (!resolver) return undefined;
  if (typeof resolver === "function") return resolver(row);
  return row[resolver];
}

function mapRow(row: Record<string, string>, mapping: FlatImportMapping): FlatImportEntityInput {
  const slug = String(resolveValue(row, mapping.slug) ?? "").trim();
  const title = String(resolveValue(row, mapping.title) ?? "").trim();

  const metadata = mapping.metadata
    ? Object.fromEntries(
      Object.entries(mapping.metadata)
        .map(([key, resolver]) => [key, resolveValue(row, resolver)])
        .filter(([, value]) => value !== undefined && value !== ""),
    )
    : undefined;

  const customFields = mapping.customFields
    ? Object.fromEntries(
      Object.entries(mapping.customFields)
        .map(([key, resolver]) => [key, resolveValue(row, resolver)])
        .filter(([, value]) => value !== undefined && value !== ""),
    )
    : undefined;

  return {
    type: mapping.entityType,
    slug,
    attributes: {
      title,
      ...(mapping.locale ? { locale: mapping.locale } : {}),
      ...(resolveValue(row, mapping.description)
        ? { description: String(resolveValue(row, mapping.description)) }
        : {}),
      ...(resolveValue(row, mapping.subtitle)
        ? { subtitle: String(resolveValue(row, mapping.subtitle)) }
        : {}),
    },
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(customFields && Object.keys(customFields).length > 0 ? { customFields } : {}),
  };
}

function normalizeRows(options: ImportFlatOptions): Result<Array<Record<string, string>>> {
  if (options.rows && options.rows.length > 0) return Ok(options.rows);

  if (options.csv) {
    return Ok(parseCsv(options.csv, options.delimiter ?? ","));
  }

  if (options.json) {
    try {
      const parsed = JSON.parse(options.json) as unknown;
      if (!Array.isArray(parsed)) {
        return Err({
          code: "IMPORT_FLAT_INVALID_JSON",
          message: "JSON payload must be an array of records.",
        });
      }

      const rows = parsed.map((value) => {
        if (!value || typeof value !== "object") return {};
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, current]) => [key, String(current ?? "")]),
        );
      });

      return Ok(rows);
    } catch (error) {
      return Err({
        code: "IMPORT_FLAT_INVALID_JSON",
        message: error instanceof Error ? error.message : "Invalid JSON payload.",
      });
    }
  }

  return Err({
    code: "IMPORT_FLAT_NO_INPUT",
    message: "Provide rows, csv, or json input for flat import.",
  });
}

export async function importFlat(options: ImportFlatOptions): Promise<Result<ImportFlatSummary>> {
  const normalized = normalizeRows(options);
  if (!normalized.ok) return normalized;

  const summary: ImportFlatSummary = {
    imported: 0,
    failed: 0,
    errors: [],
    entityIds: [],
  };

  for (let index = 0; index < normalized.value.length; index += 1) {
    try {
      const row = normalized.value[index]!;
      const mapped = mapRow(row, options.mapping);

      if (!mapped.slug) {
        throw new Error("Missing slug after mapping.");
      }
      if (!mapped.attributes.title) {
        throw new Error("Missing title after mapping.");
      }

      const created = await options.target.createEntity(mapped);
      summary.imported += 1;
      summary.entityIds.push(created.id);
    } catch (error) {
      summary.failed += 1;
      summary.errors.push({
        row: index + 1,
        message: error instanceof Error ? error.message : "Unknown import error.",
      });
    }
  }

  return Ok(summary);
}
