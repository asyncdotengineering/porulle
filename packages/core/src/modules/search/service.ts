import { Ok, type Result } from "../../kernel/result.js";
import { resolveOrgId } from "../../auth/org.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import type { CatalogRepository, SellableEntity } from "../catalog/repository/index.js";
import type {
  SearchAdapter,
  SearchDocument,
  SearchFilters,
  SearchQueryParams,
  SearchQueryResult,
  SearchSuggestParams,
} from "./adapter.js";

interface SearchServiceDeps {
  catalogRepository: CatalogRepository;
  adapter?: SearchAdapter;
  defaultFacets?: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function includesAllTokens(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const lower = haystack.toLowerCase();
  return tokens.every((token) => lower.includes(token));
}

function scoreText(document: SearchDocument, tokens: string[]): number {
  if (tokens.length === 0) return 1;

  const title = document.title.toLowerCase();
  const text = document.text.toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 2;
    if (text.includes(token)) score += 1;
  }

  return score;
}

export class SearchService {
  constructor(private deps: SearchServiceDeps) {}

  private async entityCategories(
    entityId: string,
    ctx?: TxContext,
  ): Promise<string[]> {
    const entries = await this.deps.catalogRepository.findEntityCategories(
      entityId,
      ctx,
    );

    const slugs = (
      await Promise.all(
        entries.map(async (entry) => {
          const category = await this.deps.catalogRepository.findCategoryById(
            entry.categoryId,
            ctx,
          );
          return category?.slug;
        }),
      )
    ).filter((slug): slug is string => typeof slug === "string");

    return unique(slugs);
  }

  private async entityBrands(
    entityId: string,
    ctx?: TxContext,
  ): Promise<string[]> {
    const entries = await this.deps.catalogRepository.findEntityBrands(
      entityId,
      ctx,
    );

    const slugs = (
      await Promise.all(
        entries.map(async (entry) => {
          const brand = await this.deps.catalogRepository.findBrandById(
            entry.brandId,
            ctx,
          );
          return brand?.slug;
        }),
      )
    ).filter((slug): slug is string => typeof slug === "string");

    return unique(slugs);
  }

  private async buildDocument(
    entity: SellableEntity,
    ctx?: TxContext,
  ): Promise<SearchDocument> {
    const attributes =
      await this.deps.catalogRepository.findAttributesByEntityId(
        entity.id,
        ctx,
      );
    const primary = attributes[0];
    const title = primary?.title ?? entity.slug;
    const description = primary?.description;
    const categories = await this.entityCategories(entity.id, ctx);
    const brands = await this.entityBrands(entity.id, ctx);

    const textParts: string[] = [
      entity.slug,
      title,
      description ?? "",
      ...categories,
      ...brands,
      ...attributes.map((attr) => attr.title),
      ...attributes.map((attr) => attr.description ?? ""),
    ];

    return {
      id: entity.id,
      type: entity.type,
      slug: entity.slug,
      title,
      ...(description ? { description } : {}),
      status: entity.status,
      categories,
      brands,
      text: textParts.join(" ").trim(),
      payload: {
        metadata: entity.metadata ?? undefined,
      },
    };
  }

  private async allDocuments(ctx?: TxContext): Promise<SearchDocument[]> {
    const orgId = resolveOrgId(ctx?.actor ?? null);
    const entities = await this.deps.catalogRepository.findEntities(
      orgId,
      undefined,
      ctx,
    );
    return Promise.all(
      entities.map((entity) => this.buildDocument(entity, ctx)),
    );
  }

  private matchesFilters(
    document: SearchDocument,
    filters: SearchFilters | undefined,
  ): boolean {
    if (!filters) return true;
    if (filters.type && document.type !== filters.type) return false;
    if (filters.status && document.status !== filters.status) return false;
    if (filters.category && !document.categories.includes(filters.category))
      return false;
    if (filters.brand && !document.brands.includes(filters.brand)) return false;
    return true;
  }

  private computeFacets(
    documents: SearchDocument[],
    requested?: string[],
  ): Record<string, Record<string, number>> {
    const facets =
      requested && requested.length > 0
        ? requested
        : (this.deps.defaultFacets ?? ["type", "category", "brand", "status"]);
    const output: Record<string, Record<string, number>> = {};

    for (const facet of facets) {
      if (facet === "type") {
        output.type = {};
        for (const document of documents) {
          output.type[document.type] = (output.type[document.type] ?? 0) + 1;
        }
      }

      if (facet === "status") {
        output.status = {};
        for (const document of documents) {
          const status = document.status ?? "unknown";
          output.status[status] = (output.status[status] ?? 0) + 1;
        }
      }

      if (facet === "category" || facet === "categories") {
        output.category = {};
        for (const document of documents) {
          for (const category of document.categories) {
            output.category[category] = (output.category[category] ?? 0) + 1;
          }
        }
      }

      if (facet === "brand" || facet === "brands") {
        output.brand = {};
        for (const document of documents) {
          for (const brand of document.brands) {
            output.brand[brand] = (output.brand[brand] ?? 0) + 1;
          }
        }
      }
    }

    return output;
  }

  async syncEntity(entityId: string, ctx?: TxContext): Promise<Result<void>> {
    if (!this.deps.adapter) return Ok(undefined);

    const entity = await this.deps.catalogRepository.findEntityById(
      entityId,
      ctx,
    );
    if (!entity) {
      return this.deps.adapter.remove([entityId]);
    }

    return this.deps.adapter.index([await this.buildDocument(entity, ctx)]);
  }

  async query(
    params: SearchQueryParams,
    ctx?: TxContext,
  ): Promise<Result<SearchQueryResult>> {
    const page = clamp(params.page ?? 1, 1, 100000);
    const limit = clamp(params.limit ?? 20, 1, 100);

    // Cap query length to prevent abuse / excessive processing
    const safeQuery = (params.query ?? "").slice(0, 500);

    if (this.deps.adapter) {
      return this.deps.adapter.search({
        ...params,
        query: safeQuery,
        page,
        limit,
      });
    }

    // In-memory fallback: require a non-empty query to avoid loading all entities
    // (allDocuments triggers N+1 DB queries per entity — unsafe at scale)
    const tokens = tokenize(safeQuery);
    if (tokens.length === 0 && !params.filters?.type && !params.filters?.category && !params.filters?.brand && !params.filters?.status) {
      return Ok({ hits: [], total: 0, page, limit, facets: {} });
    }

    try {
      const allDocs = await this.allDocuments(ctx);
      const filtered = allDocs.filter((document) => {
        if (!this.matchesFilters(document, params.filters)) return false;
        if (tokens.length === 0) return true;
        return includesAllTokens(document.text, tokens);
      });

      const scored = filtered
        .map((document) => ({
          document,
          score: scoreText(document, tokens),
        }))
        .sort((first, second) => {
          if (second.score !== first.score) return second.score - first.score;
          return first.document.title.localeCompare(second.document.title);
        });

      const offset = (page - 1) * limit;
      const hits = scored.slice(offset, offset + limit).map((row) => ({
        id: row.document.id,
        score: row.score,
        document: row.document,
      }));

      return Ok({
        hits,
        total: scored.length,
        page,
        limit,
        facets: this.computeFacets(filtered, params.facets),
      });
    } catch (error) {
      // In-memory search is best-effort; surface error as empty result
      // rather than crashing the entire request with a 500
      console.error("[search] In-memory fallback failed:", error instanceof Error ? error.message : error);
      return Ok({ hits: [], total: 0, page, limit, facets: {} });
    }
  }

  async suggest(
    params: SearchSuggestParams,
    ctx?: TxContext,
  ): Promise<Result<string[]>> {
    const limit = clamp(params.limit ?? 10, 1, 25);
    const prefix = (params.prefix ?? "").trim().toLowerCase().slice(0, 200);

    if (prefix.length === 0) return Ok([]);

    if (this.deps.adapter) {
      return this.deps.adapter.suggest({
        ...params,
        prefix,
        limit,
      });
    }

    // In-memory fallback: require prefix >= 2 chars to avoid loading all entities
    // (allDocuments triggers N+1 DB queries per entity — unsafe at scale)
    if (prefix.length < 2) return Ok([]);

    try {
      const allDocs = await this.allDocuments(ctx);
      const titles = allDocs
        .filter(
          (document) =>
            (!params.type || document.type === params.type) &&
            document.title.toLowerCase().startsWith(prefix),
        )
        .map((document) => document.title)
        .filter((title, index, list) => list.indexOf(title) === index)
        .slice(0, limit);

      return Ok(titles);
    } catch (error) {
      console.error("[search] Suggest fallback failed:", error instanceof Error ? error.message : error);
      return Ok([]);
    }
  }
}
