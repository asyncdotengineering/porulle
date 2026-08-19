import { MeiliSearch } from "meilisearch";
import { Err, Ok, type Result, type SearchAdapter, type SearchDocument, type SearchQueryParams, type SearchQueryResult, type SearchSuggestParams } from "@porulle/core";

interface MeiliIndexLike {
  addDocuments(documents: SearchDocument[]): Promise<unknown>;
  deleteDocuments(ids: string[]): Promise<unknown>;
  search(
    query: string,
    options?: {
      filter?: string | string[];
      facets?: string[];
      limit?: number;
      offset?: number;
      attributesToRetrieve?: string[];
    },
  ): Promise<{
    hits: Array<SearchDocument & { _rankingScore?: number }>;
    estimatedTotalHits?: number;
    facetDistribution?: Record<string, Record<string, number>>;
  }>;
  updateFilterableAttributes(attributes: string[]): Promise<unknown>;
  getFilterableAttributes?(): Promise<unknown>;
}

interface MeiliClientLike {
  index(uid: string): MeiliIndexLike;
}

export interface MeilisearchAdapterOptions {
  host: string;
  apiKey?: string;
  indexName?: string;
  filterableAttributes?: string[];
  client?: MeiliClientLike;
}

const SAFE_ATTRIBUTE_NAME = /^[A-Za-z0-9_-]+$/;

function toFilter(params: SearchQueryParams): string[] {
  const filters: string[] = [];

  if (params.filters?.type) {
    filters.push(`type = \"${params.filters.type}\"`);
  }

  if (params.filters?.status) {
    filters.push(`status = \"${params.filters.status}\"`);
  }

  if (params.filters?.category) {
    filters.push(`categories = \"${params.filters.category}\"`);
  }

  if (params.filters?.brand) {
    filters.push(`brands = \"${params.filters.brand}\"`);
  }

  for (const [name, requested] of Object.entries(params.filters?.attributes ?? {})) {
    const values = Array.isArray(requested) ? requested : [requested];
    if (values.length === 0 || !SAFE_ATTRIBUTE_NAME.test(name)) {
      filters.push('id = ""');
      continue;
    }
    const expressions = values.map((value) => `attributes.${name} = ${JSON.stringify(value)}`);
    if (expressions.length > 1) {
      filters.push(`(${expressions.join(" OR ")})`);
    } else if (expressions.length === 1) {
      filters.push(expressions[0]!);
    }
  }

  return filters;
}

function normalizeFacets(
  facets: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(facets).map(([name, values]) => [
      name.startsWith("attributes.") ? name.slice("attributes.".length) : name,
      values,
    ]),
  );
}

function toFacetName(name: string): string {
  if (["type", "status", "category", "categories", "brand", "brands"].includes(name)) return name;
  return name.startsWith("attributes.") ? name : `attributes.${name}`;
}

function normalizeSearchResult(
  params: SearchQueryParams,
  result: {
    hits: Array<SearchDocument & { _rankingScore?: number }>;
    estimatedTotalHits?: number;
    facetDistribution?: Record<string, Record<string, number>>;
  },
): SearchQueryResult {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;

  return {
    hits: result.hits.map((document) => ({
      id: document.id,
      ...(document._rankingScore !== undefined ? { score: document._rankingScore } : {}),
      document,
    })),
    total: result.estimatedTotalHits ?? result.hits.length,
    page,
    limit,
    facets: normalizeFacets(result.facetDistribution ?? {}),
  };
}

export function meilisearchAdapter(options: MeilisearchAdapterOptions): SearchAdapter {
  const client: MeiliClientLike =
    options.client ?? new MeiliSearch({ host: options.host, ...(options.apiKey ? { apiKey: options.apiKey } : {}) });
  const indexName = options.indexName ?? "catalog";
  const filterable = options.filterableAttributes ?? ["type", "status", "categories", "brands"];

  const attributeNames = new Set<string>();
  let configuredFilterable: string[] | undefined;

  async function ensureFilterable(index: MeiliIndexLike, documents: SearchDocument[]): Promise<void> {
    for (const document of documents) {
      for (const name of Object.keys(document.attributes ?? {})) {
        if (SAFE_ATTRIBUTE_NAME.test(name)) attributeNames.add(name);
      }
    }
    if (configuredFilterable === undefined && index.getFilterableAttributes) {
      const stored = await index.getFilterableAttributes();
      configuredFilterable = Array.isArray(stored)
        ? stored.filter((name): name is string => typeof name === "string")
        : [];
    }
    const nextFilterable = [
      ...(configuredFilterable ?? []),
      ...filterable,
      ...[...attributeNames].map((name) => `attributes.${name}`),
    ].filter((name, position, list) => list.indexOf(name) === position);
    if (configuredFilterable?.length === nextFilterable.length && configuredFilterable.every((name, index) => name === nextFilterable[index])) return;
    await index.updateFilterableAttributes(nextFilterable);
    configuredFilterable = nextFilterable;
  }

  return {
    providerId: "meilisearch",

    async index(documents): Promise<Result<void>> {
      try {
        if (documents.length === 0) return Ok(undefined);
        const index = client.index(indexName);
        await ensureFilterable(index, documents);
        await index.addDocuments(documents);
        return Ok(undefined);
      } catch (error) {
        return Err({
          code: "MEILISEARCH_INDEX_FAILED",
          message: error instanceof Error ? error.message : "Failed to index Meilisearch documents.",
        });
      }
    },

    async remove(ids): Promise<Result<void>> {
      try {
        if (ids.length === 0) return Ok(undefined);
        const index = client.index(indexName);
        await index.deleteDocuments(ids);
        return Ok(undefined);
      } catch (error) {
        return Err({
          code: "MEILISEARCH_DELETE_FAILED",
          message: error instanceof Error ? error.message : "Failed to delete Meilisearch documents.",
        });
      }
    },

    async search(params): Promise<Result<SearchQueryResult>> {
      try {
        const page = params.page ?? 1;
        const limit = params.limit ?? 20;
        const offset = (page - 1) * limit;
        const filters = toFilter(params);

        const index = client.index(indexName);
        const requestedFacets = (params.facets ?? ["type", "status", "categories", "brands"]).map(toFacetName);
        const facets = requestedFacets.filter((name, position, list) => list.indexOf(name) === position);
        const result = await index.search(params.query, {
          ...(filters.length > 0 ? { filter: filters } : {}),
          facets,
          limit,
          offset,
        });

        return Ok(normalizeSearchResult({ ...params, page, limit }, result));
      } catch (error) {
        return Err({
          code: "MEILISEARCH_QUERY_FAILED",
          message: error instanceof Error ? error.message : "Meilisearch query failed.",
        });
      }
    },

    async suggest(params: SearchSuggestParams): Promise<Result<string[]>> {
      try {
        const index = client.index(indexName);
        const result = await index.search(params.prefix, {
          ...(params.type ? { filter: [`type = \"${params.type}\"`] } : {}),
          attributesToRetrieve: ["title"],
          limit: params.limit ?? 10,
        });

        const prefix = params.prefix.toLowerCase();
        const suggestions = result.hits
          .map((hit) => hit.title)
          .filter((title): title is string => typeof title === "string")
          .filter((title, index, list) => list.indexOf(title) === index)
          .filter((title) => title.toLowerCase().startsWith(prefix))
          .slice(0, params.limit ?? 10);

        return Ok(suggestions);
      } catch (error) {
        return Err({
          code: "MEILISEARCH_SUGGEST_FAILED",
          message: error instanceof Error ? error.message : "Meilisearch suggest failed.",
        });
      }
    },
  };
}
