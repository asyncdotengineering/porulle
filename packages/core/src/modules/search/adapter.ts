import type { Result } from "../../kernel/result.js";
import type { PluginDb } from "../../kernel/database/plugin-types.js";

export interface SearchDocument {
  id: string;
  organizationId?: string;
  type: string;
  slug: string;
  title: string;
  description?: string;
  status?: string;
  isVisible?: boolean;
  categories: string[];
  brands: string[];
  text: string;
  attributes?: Record<string, string | string[]>;
  payload?: Record<string, unknown>;
}

export interface SearchFilters {
  /** Server-supplied tenant constraint; REST callers cannot choose this value. */
  organizationId?: string;
  type?: string;
  category?: string;
  brand?: string;
  status?: string;
  attributes?: Record<string, string | string[]>;
}

export interface SearchQueryParams {
  query: string;
  page?: number;
  limit?: number;
  filters?: SearchFilters;
  facets?: string[];
}

export interface SearchSuggestParams {
  prefix: string;
  type?: string;
  limit?: number;
  /** Server-supplied tenant constraint; REST callers cannot choose this value. */
  organizationId?: string;
}

export interface SearchHit {
  id: string;
  score?: number;
  document: SearchDocument;
}

export interface SearchQueryResult {
  hits: SearchHit[];
  total: number;
  page: number;
  limit: number;
  facets: Record<string, Record<string, number>>;
}

export interface SearchAdapter {
  readonly providerId: string;
  /** Called once when the search module wires the adapter to the live database. */
  init?(deps: { db: PluginDb }): void;
  index(documents: SearchDocument[]): Promise<Result<void>>;
  remove(ids: string[]): Promise<Result<void>>;
  search(params: SearchQueryParams): Promise<Result<SearchQueryResult>>;
  suggest(params: SearchSuggestParams): Promise<Result<string[]>>;
}
