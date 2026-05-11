import type { Result } from "../../kernel/result.js";

export interface SearchDocument {
  id: string;
  type: string;
  slug: string;
  title: string;
  description?: string;
  status?: string;
  categories: string[];
  brands: string[];
  text: string;
  payload?: Record<string, unknown>;
}

export interface SearchFilters {
  type?: string;
  category?: string;
  brand?: string;
  status?: string;
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
  index(documents: SearchDocument[]): Promise<Result<void>>;
  remove(ids: string[]): Promise<Result<void>>;
  search(params: SearchQueryParams): Promise<Result<SearchQueryResult>>;
  suggest(params: SearchSuggestParams): Promise<Result<string[]>>;
}
