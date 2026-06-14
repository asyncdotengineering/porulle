import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import type { Result } from "../../kernel/result.js";
import type { Pagination } from "../../utils/pagination.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import type { TxContext } from "../../kernel/database/tx-context.js";
import {
  CatalogRepository,
  type SellableEntity,
  type SellableAttribute,
  type EntityCategory,
  type EntityBrand,
  type Brand,
  type OptionType,
  type OptionValue,
  type Variant,
} from "./repository/index.js";

// ─── Re-exported schema-derived types ────────────────────────────────────────
export type {
  CreateEntityInput,
  UpdateEntityInput,
  CreateCategoryInput,
  UpdateCategoryInput,
  CreateBrandInput,
  UpdateBrandInput,
  CreateOptionTypeInput,
  CreateOptionValueInput,
  CreateVariantInput,
} from "./schemas.js";

import type {
  CreateEntityInput,
  UpdateEntityInput,
  CreateCategoryInput,
  UpdateCategoryInput,
  CreateBrandInput,
  UpdateBrandInput,
  CreateOptionTypeInput,
  CreateOptionValueInput,
  CreateVariantInput,
} from "./schemas.js";

import { EntityService } from "./entity-service.js";
import { CategoryService } from "./category-service.js";
import { BrandService } from "./brand-service.js";

// ─── Hand-written types (not derivable from a single z.infer) ───────────────

export interface SetAttributesInput {
  title: string;
  subtitle?: string;
  description?: string;
  richDescription?: unknown;
  seoTitle?: string;
  seoDescription?: string;
}

export interface ListParams {
  filter?: {
    type?: string;
    status?: string;
    category?: string;
    brand?: string;
    customField?: {
      fieldName: string;
      value: unknown;
    };
  };
  sort?: {
    field: "createdAt" | "updatedAt" | "slug";
    direction: "asc" | "desc";
  };
  pagination?: {
    page: number;
    limit: number;
  };
}

export interface GetOptions {
  includeAttributes?: boolean | { locales: string[] };
  includeVariants?: boolean;
  includeOptionTypes?: boolean;
  includePricing?: boolean;
  includeInventory?: boolean;
  includeMedia?: boolean;
  includeCategories?: boolean;
  includeBrands?: boolean;
}

export interface VariantMatrixRule {
  include?: string[][];
  exclude?: string[][];
}

export type VariantGenerationStrategy =
  | { mode: "all" }
  | { mode: "manual"; combinations: string[][] }
  | { mode: "matrix"; matrix: VariantMatrixRule };

export interface CatalogEntityHydrated extends SellableEntity {
  attributes?: SellableAttribute[];
  variants?: Array<Variant & { optionValueIds: string[] }>;
  optionTypes?: Array<OptionType & { values: OptionValue[] }>;
  categories?: EntityCategory[];
  brands?: EntityBrand[];
  media?: Array<{ mediaAssetId: string; role: string; variantId?: string }>;
  pricing?: Array<{ currency: string; amount: number; compareAtAmount?: number | null }>;
}

export interface CatalogService {
  readonly repository: CatalogRepository;
  create(
    input: CreateEntityInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  update(
    id: string,
    input: UpdateEntityInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  delete(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  getById(
    id: string,
    options?: GetOptions,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  getBySlug(
    slug: string,
    options?: GetOptions,
    actor?: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  list(params: ListParams, actor?: Actor | null, ctx?: TxContext): Promise<Result<CatalogListResult>>;
  publish(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  archive(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  discontinue(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  setAttributes(
    entityId: string,
    locale: string,
    attrs: SetAttributesInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  getAttributes(
    entityId: string,
    locale: string,
    ctx?: TxContext,
  ): Promise<Result<SellableAttribute>>;
  listCategories(
    ctx?: TxContext,
    opts?: { includeArchived?: boolean },
  ): Promise<Result<CategorySummary[]>>;
  createCategory(
    input: CreateCategoryInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CategorySummary>>;
  archiveCategory(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CategorySummary>>;
  restoreCategory(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CategorySummary>>;
  updateCategory(
    id: string,
    input: UpdateCategoryInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CategorySummary>>;
  deleteCategory(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  addToCategory(
    entityId: string,
    categoryId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  removeFromCategory(
    entityId: string,
    categoryId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  listBrands(ctx?: TxContext): Promise<Result<Brand[]>>;
  createBrand(
    input: CreateBrandInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Brand>>;
  updateBrand(
    id: string,
    input: UpdateBrandInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Brand>>;
  deleteBrand(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  addToBrand(
    entityId: string,
    brandId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  removeFromBrand(
    entityId: string,
    brandId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<void>>;
  createOptionType(
    input: CreateOptionTypeInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OptionType>>;
  createOptionValue(
    input: CreateOptionValueInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<OptionValue>>;
  createVariant(
    input: CreateVariantInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Variant>>;
  generateVariants(
    entityId: string,
    strategy: VariantGenerationStrategy,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<Variant[]>>;
}

export interface CatalogServiceDeps {
  repository: CatalogRepository;
  hooks: HookRegistry;
  config: CommerceConfig;
  services: Record<string, unknown>;
  database: DatabaseAdapter;
}

export type CatalogListResult = {
  items: CatalogEntityHydrated[];
  pagination: Pagination;
};

export type CategorySummary = {
  id: string;
  parentId?: string | null;
  slug: string;
  sortOrder: number;
  status: string;
  metadata: Record<string, unknown>;
};

export class CatalogServiceImpl implements CatalogService {
  readonly repository: CatalogRepository;
  private readonly entities: EntityService;
  private readonly categories: CategoryService;
  private readonly brands: BrandService;

  constructor(deps: CatalogServiceDeps) {
    this.repository = deps.repository;
    this.entities = new EntityService(deps);
    this.categories = new CategoryService(deps);
    this.brands = new BrandService(deps);
  }

  create(input: CreateEntityInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.entities.create(input, actor, ctx);
  }

  update(id: string, input: UpdateEntityInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.entities.update(id, input, actor, ctx);
  }

  delete(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.entities.delete(id, actor, ctx);
  }

  getById(id: string, options?: GetOptions, actor?: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.entities.getById(id, options, actor, ctx);
  }

  getBySlug(slug: string, options?: GetOptions, actor?: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.entities.getBySlug(slug, options, actor, ctx);
  }

  list(params: ListParams, actor?: Actor | null, ctx?: TxContext): Promise<Result<CatalogListResult>> {
    return this.entities.list(params, actor, ctx);
  }

  publish(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.entities.publish(id, actor, ctx);
  }

  archive(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.entities.archive(id, actor, ctx);
  }

  discontinue(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.entities.discontinue(id, actor, ctx);
  }

  setAttributes(entityId: string, locale: string, attrs: SetAttributesInput, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.entities.setAttributes(entityId, locale, attrs, actor, ctx);
  }

  getAttributes(entityId: string, locale: string, ctx?: TxContext): Promise<Result<SellableAttribute>> {
    return this.entities.getAttributes(entityId, locale, ctx);
  }

  listCategories(ctx?: TxContext, opts?: { includeArchived?: boolean }): Promise<Result<CategorySummary[]>> {
    return this.categories.listCategories(ctx, opts);
  }

  createCategory(input: CreateCategoryInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CategorySummary>> {
    return this.categories.createCategory(input, actor, ctx);
  }

  archiveCategory(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CategorySummary>> {
    return this.categories.archiveCategory(id, actor, ctx);
  }

  restoreCategory(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CategorySummary>> {
    return this.categories.restoreCategory(id, actor, ctx);
  }

  updateCategory(id: string, input: UpdateCategoryInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CategorySummary>> {
    return this.categories.updateCategory(id, input, actor, ctx);
  }

  deleteCategory(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.categories.deleteCategory(id, actor, ctx);
  }

  addToCategory(entityId: string, categoryId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.categories.addToCategory(entityId, categoryId, actor, ctx);
  }

  removeFromCategory(entityId: string, categoryId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.categories.removeFromCategory(entityId, categoryId, actor, ctx);
  }

  listBrands(ctx?: TxContext): Promise<Result<Brand[]>> {
    return this.brands.listBrands(ctx);
  }

  createBrand(input: CreateBrandInput, actor: Actor | null, ctx?: TxContext): Promise<Result<Brand>> {
    return this.brands.createBrand(input, actor, ctx);
  }

  updateBrand(id: string, input: UpdateBrandInput, actor: Actor | null, ctx?: TxContext): Promise<Result<Brand>> {
    return this.brands.updateBrand(id, input, actor, ctx);
  }

  deleteBrand(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.brands.deleteBrand(id, actor, ctx);
  }

  addToBrand(entityId: string, brandId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.brands.addToBrand(entityId, brandId, actor, ctx);
  }

  removeFromBrand(entityId: string, brandId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.brands.removeFromBrand(entityId, brandId, actor, ctx);
  }

  createOptionType(input: CreateOptionTypeInput, actor: Actor | null, ctx?: TxContext): Promise<Result<OptionType>> {
    return this.entities.createOptionType(input, actor, ctx);
  }

  createOptionValue(input: CreateOptionValueInput, actor: Actor | null, ctx?: TxContext): Promise<Result<OptionValue>> {
    return this.entities.createOptionValue(input, actor, ctx);
  }

  createVariant(input: CreateVariantInput, actor: Actor | null, ctx?: TxContext): Promise<Result<Variant>> {
    return this.entities.createVariant(input, actor, ctx);
  }

  generateVariants(entityId: string, strategy: VariantGenerationStrategy, actor: Actor | null, ctx?: TxContext): Promise<Result<Variant[]>> {
    return this.entities.generateVariants(entityId, strategy, actor, ctx);
  }
}
