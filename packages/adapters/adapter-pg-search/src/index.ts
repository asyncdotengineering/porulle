import {
  Err,
  Ok,
  type Result,
  type SearchAdapter,
  type SearchDocument,
  type SearchQueryParams,
  type SearchQueryResult,
  type SearchSuggestParams,
} from "@porulle/core";

export interface PgSearchQueryResultRow {
  [key: string]: unknown;
}

export interface PgSearchAdapterOptions {
  query: (sql: string, params: unknown[]) => Promise<{ rows: PgSearchQueryResultRow[] }>;
  tableName?: string;
  dictionary?: string;
}

function safeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return value;
}

function parseCategories(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return [];
    }
  }

  return [];
}

function parseBrands(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      return [];
    }
  }

  return [];
}

function parseAttributes(value: unknown): Record<string, string | string[]> {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const attributes: Record<string, string | string[]> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") {
      attributes[key] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      attributes[key] = entry as string[];
    }
  }
  return attributes;
}

function attributeValues(document: SearchDocument, name: string): string[] {
  const value = document.attributes?.[name];
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function toDocument(row: PgSearchQueryResultRow): SearchDocument {
  const attributes = parseAttributes(row.attributes);
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : {};
  const organizationId = typeof payload.organizationId === "string"
    ? payload.organizationId
    : undefined;
  return {
    id: String(row.id ?? ""),
    ...(organizationId ? { organizationId } : {}),
    type: String(row.type ?? ""),
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    ...(row.description ? { description: String(row.description) } : {}),
    ...(row.status ? { status: String(row.status) } : {}),
    categories: parseCategories(row.categories),
    brands: parseBrands(row.brands),
    text: String(row.text ?? ""),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
  };
}

function buildWhere(
  params: SearchQueryParams,
  dictionary: string,
): { sql: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.query.trim().length > 0) {
    values.push(params.query);
    clauses.push(`to_tsvector('${dictionary}', text) @@ plainto_tsquery('${dictionary}', $${values.length})`);
  }

  if (params.filters?.type) {
    values.push(params.filters.type);
    clauses.push(`type = $${values.length}`);
  }

  if (params.filters?.organizationId) {
    values.push(params.filters.organizationId);
    clauses.push(`payload ->> 'organizationId' = $${values.length}`);
  }

  if (params.filters?.status) {
    values.push(params.filters.status);
    clauses.push(`status = $${values.length}`);
  }

  if (params.filters?.category) {
    values.push(params.filters.category);
    clauses.push(`$${values.length} = ANY(categories)`);
  }

  if (params.filters?.brand) {
    values.push(params.filters.brand);
    clauses.push(`$${values.length} = ANY(brands)`);
  }

  for (const [name, requested] of Object.entries(params.filters?.attributes ?? {})) {
    values.push(name);
    const keyPlaceholder = `$${values.length}`;
    const requestedValues = Array.isArray(requested) ? requested : [requested];
    if (requestedValues.length === 0) {
      clauses.push("FALSE");
      continue;
    }
    const valuePlaceholders = requestedValues.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    clauses.push(
      `EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(attributes -> ${keyPlaceholder}) = 'array' THEN attributes -> ${keyPlaceholder} ELSE jsonb_build_array(attributes ->> ${keyPlaceholder}) END) AS attribute_value WHERE attribute_value IN (${valuePlaceholders.join(", ")}))`,
    );
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    values,
  };
}

function computeFacets(documents: SearchDocument[], requested?: string[]): Record<string, Record<string, number>> {
  const facets = requested && requested.length > 0 ? requested : ["type", "status", "category", "brand"];
  const output: Record<string, Record<string, number>> = {};

  if (facets.includes("type")) {
    output.type = {};
    for (const document of documents) {
      output.type[document.type] = (output.type[document.type] ?? 0) + 1;
    }
  }

  if (facets.includes("status")) {
    output.status = {};
    for (const document of documents) {
      const status = document.status ?? "unknown";
      output.status[status] = (output.status[status] ?? 0) + 1;
    }
  }

  if (facets.includes("category") || facets.includes("categories")) {
    output.category = {};
    for (const document of documents) {
      for (const category of document.categories) {
        output.category[category] = (output.category[category] ?? 0) + 1;
      }
    }
  }

  if (facets.includes("brand") || facets.includes("brands")) {
    output.brand = {};
    for (const document of documents) {
      for (const brand of document.brands) {
        output.brand[brand] = (output.brand[brand] ?? 0) + 1;
      }
    }
  }

  for (const facet of facets) {
    const attributeName = facet.startsWith("attributes.")
      ? facet.slice("attributes.".length)
      : facet;
    if (["type", "status", "category", "categories", "brand", "brands"].includes(attributeName)) continue;
    const values: Record<string, number> = {};
    for (const document of documents) {
      for (const value of new Set(attributeValues(document, attributeName))) {
        values[value] = (values[value] ?? 0) + 1;
      }
    }
    if (Object.keys(values).length > 0) output[attributeName] = values;
  }

  return output;
}

export function pgSearchAdapter(options: PgSearchAdapterOptions): SearchAdapter {
  const table = safeIdentifier(options.tableName ?? "search_index");
  const dictionary = options.dictionary ?? "english";

  return {
    providerId: "pg-search",

    async index(documents: SearchDocument[]): Promise<Result<void>> {
      try {
        if (documents.length === 0) return Ok(undefined);

        for (const document of documents) {
          await options.query(
            `INSERT INTO ${table} (id, type, slug, title, description, status, categories, brands, text, attributes, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
             ON CONFLICT (id)
             DO UPDATE SET
               type = EXCLUDED.type,
               slug = EXCLUDED.slug,
               title = EXCLUDED.title,
               description = EXCLUDED.description,
               status = EXCLUDED.status,
               categories = EXCLUDED.categories,
               brands = EXCLUDED.brands,
               text = EXCLUDED.text,
               attributes = EXCLUDED.attributes,
               payload = EXCLUDED.payload`,
            [
              document.id,
              document.type,
              document.slug,
              document.title,
              document.description ?? null,
              document.status ?? null,
              document.categories,
              document.brands,
              document.text,
              JSON.stringify(document.attributes ?? {}),
              JSON.stringify({
                ...(document.payload ?? {}),
                ...(document.organizationId ? { organizationId: document.organizationId } : {}),
              }),
            ],
          );
        }

        return Ok(undefined);
      } catch (error) {
        return Err({
          code: "PG_SEARCH_INDEX_FAILED",
          message: error instanceof Error ? error.message : "pg-search indexing failed.",
        });
      }
    },

    async remove(ids: string[]): Promise<Result<void>> {
      try {
        if (ids.length === 0) return Ok(undefined);
        await options.query(`DELETE FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
        return Ok(undefined);
      } catch (error) {
        return Err({
          code: "PG_SEARCH_DELETE_FAILED",
          message: error instanceof Error ? error.message : "pg-search delete failed.",
        });
      }
    },

    async search(params: SearchQueryParams): Promise<Result<SearchQueryResult>> {
      try {
        const page = Math.max(1, params.page ?? 1);
        const limit = Math.max(1, Math.min(100, params.limit ?? 20));
        const offset = (page - 1) * limit;

        const where = buildWhere(params, dictionary);
        const scoreExpr = params.query.trim().length > 0
          ? `ts_rank(to_tsvector('${dictionary}', text), plainto_tsquery('${dictionary}', $1))`
          : "0";

        const rows = await options.query(
          `SELECT id, type, slug, title, description, status, categories, brands, text, attributes, payload, ${scoreExpr} AS score
           FROM ${table}
           ${where.sql}
           ORDER BY score DESC, title ASC
           LIMIT $${where.values.length + 1}
           OFFSET $${where.values.length + 2}`,
          [...where.values, limit, offset],
        );

        const countRows = await options.query(
          `SELECT COUNT(*)::int AS total FROM ${table} ${where.sql}`,
          where.values,
        );

        const facetRows = await options.query(
          `SELECT id, type, slug, title, description, status, categories, brands, text, attributes, payload
           FROM ${table}
           ${where.sql}`,
          where.values,
        );

        const documents = facetRows.rows.map((row) => toDocument(row));
        const hits = rows.rows.map((row) => ({
          id: String(row.id ?? ""),
          score: Number(row.score ?? 0),
          document: toDocument(row),
        }));

        return Ok({
          hits,
          total: Number(countRows.rows[0]?.total ?? hits.length),
          page,
          limit,
          facets: computeFacets(documents, params.facets),
        });
      } catch (error) {
        return Err({
          code: "PG_SEARCH_QUERY_FAILED",
          message: error instanceof Error ? error.message : "pg-search query failed.",
        });
      }
    },

    async suggest(params: SearchSuggestParams): Promise<Result<string[]>> {
      try {
        const limit = Math.max(1, Math.min(25, params.limit ?? 10));
        const prefix = params.prefix.trim().toLowerCase();

        if (!prefix) return Ok([]);

        const conditions = ["LOWER(title) LIKE $1"];
        const values: unknown[] = [`${prefix}%`];

        if (params.type) {
          values.push(params.type);
          conditions.push(`type = $${values.length}`);
        }

        if (params.organizationId) {
          values.push(params.organizationId);
          conditions.push(`payload ->> 'organizationId' = $${values.length}`);
        }

        values.push(limit);

        const rows = await options.query(
          `SELECT DISTINCT title
           FROM ${table}
           WHERE ${conditions.join(" AND ")}
           ORDER BY title ASC
           LIMIT $${values.length}`,
          values,
        );

        const suggestions = rows.rows
          .map((row) => String(row.title ?? ""))
          .filter(Boolean)
          .slice(0, limit);

        return Ok(suggestions);
      } catch (error) {
        return Err({
          code: "PG_SEARCH_SUGGEST_FAILED",
          message: error instanceof Error ? error.message : "pg-search suggest failed.",
        });
      }
    },
  };
}
