import type { Actor } from "../../auth/types.js";
import { resolveOrgId } from "../../auth/org.js";
import { assertPermission } from "../../auth/permissions.js";
import type { CommerceConfig } from "../../config/types.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { CommerceNotFoundError, toCommerceError } from "../../kernel/errors.js";
import type { Pagination } from "../../utils/pagination.js";
import type { DatabaseAdapter } from "../../kernel/database/adapter.js";
import { createTxContext, type TxContext } from "../../kernel/database/tx-context.js";
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
  type SellableEntityRevision,
  type SellableEntityInsert,
  type SellableAttributeInsert,
  type SellableCustomFieldInsert,
} from "./repository/index.js";
import type { SellableEntityRevisionReason, SellableEntityRevisionSnapshot } from "./schema.js";
import { comparableSerialize } from "./revision.js";

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
  media?: Array<{ mediaAssetId: string; role: string; sortOrder: number; variantId: string | null; url: string; alt: string | null; contentType: string }>;
  pricing?: Array<{ id: string; currency: string; amount: number; compareAtAmount?: number | null; createdAt: Date }>;
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
  quickCreateVariant(
    entityId: string,
    input: { options: Record<string, string>; sku?: string | undefined; barcode?: string | undefined },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ variant: Variant; created: boolean }>>;
  bulkCreateVariants(
    entityId: string,
    input: { axes: Array<{ name: string; values: string[] }>; skuPrefix?: string | undefined },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ created: Variant[]; skipped: number }>>;
  recordEntityRevision(
    entityId: string,
    actor: Actor | null,
    reason?: SellableEntityRevisionReason,
    ctx?: TxContext,
  ): Promise<Result<SellableEntityRevision>>;
  restoreEntityRevision(
    entityId: string,
    revisionId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>>;
  trimEntityRevisions(
    actor: Actor | null,
    olderThanDays?: number,
    ctx?: TxContext,
  ): Promise<Result<number>>;
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

function isUniqueViolation(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (value.code === "23505") return true;
  return isUniqueViolation(value.cause);
}

export class CatalogServiceImpl implements CatalogService {
  readonly repository: CatalogRepository;
  private readonly database: DatabaseAdapter;
  private readonly entities: EntityService;
  private readonly categories: CategoryService;
  private readonly brands: BrandService;

  constructor(deps: CatalogServiceDeps) {
    this.repository = deps.repository;
    this.database = deps.database;
    this.entities = new EntityService(deps);
    this.categories = new CategoryService(deps);
    this.brands = new BrandService(deps);
  }

  private async withMutation<T>(
    actor: Actor | null,
    ctx: TxContext | undefined,
    fn: (txCtx: TxContext) => Promise<T>,
  ): Promise<T> {
    if (ctx?.tx != null) return fn(ctx);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(async (tx) => fn(createTxContext(tx, { actor })));
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 2) throw error;
      }
    }
    throw new Error("Catalog mutation retry limit reached.");
  }

  private async withMutationResult<T>(
    actor: Actor | null,
    ctx: TxContext | undefined,
    fn: (txCtx: TxContext) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    try {
      return await this.withMutation(actor, ctx, fn);
    } catch (error) {
      return Err(toCommerceError(error));
    }
  }

  private async captureRevision(
    entityId: string,
    actor: Actor | null,
    reason: SellableEntityRevisionReason,
    ctx: TxContext,
    force = false,
  ): Promise<SellableEntityRevision> {
    const snapshot = await this.repository.snapshotEntity(entityId, ctx);
    const latest = await this.repository.findLatestRevision(entityId, ctx);
    if (!(force || reason === "push") && latest && comparableSerialize(latest.snapshot) === comparableSerialize(snapshot)) return latest;
    const revisionActor = actor ?? ctx.actor;
    const organizationId = typeof snapshot.entity.organizationId === "string"
      ? snapshot.entity.organizationId
      : resolveOrgId(revisionActor);
    return this.repository.createRevision({
      organizationId,
      entityId,
      snapshot,
      reason,
      actorId: revisionActor?.userId ?? null,
      actorType: revisionActor?.type ?? null,
      requestId: ctx.requestId,
    }, ctx);
  }

  async recordEntityRevision(
    entityId: string,
    actor: Actor | null,
    reason: SellableEntityRevisionReason = "update",
    ctx?: TxContext,
  ): Promise<Result<SellableEntityRevision>> {
    try {
      return await this.withMutation(actor, ctx, async (txCtx) => {
        const revisionActor = actor ?? txCtx.actor;
        assertPermission(revisionActor, "catalog:update");
        const entity = await this.repository.findEntityById(entityId, txCtx);
        if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
        if (entity.organizationId !== resolveOrgId(revisionActor)) {
          return Err(new CommerceNotFoundError("Entity not found."));
        }
        return Ok(await this.captureRevision(entityId, revisionActor, reason, txCtx));
      });
    } catch (error) {
      return Err(toCommerceError(error));
    }
  }

  private restoreDate(value: unknown): Date | null {
    if (value == null) return null;
    return value instanceof Date ? value : new Date(String(value));
  }

  private async applyRevisionSnapshot(
    entityId: string,
    snapshot: SellableEntityRevisionSnapshot,
    ctx: TxContext,
  ): Promise<void> {
    const entity = snapshot.entity as unknown as SellableEntity;
    const entityData: Partial<SellableEntityInsert> = {
      sourceStoreId: entity.sourceStoreId,
      type: entity.type,
      slug: entity.slug,
      status: entity.status,
      isVisible: entity.isVisible,
      taxClass: entity.taxClass,
      metadata: entity.metadata,
      publishedAt: this.restoreDate((snapshot.entity as Record<string, unknown>).publishedAt),
    };
    await this.repository.updateEntity(entityId, entityData, ctx);

    await this.repository.deleteAttributesByEntityId(entityId, ctx);
    for (const row of snapshot.attributes as unknown as Array<SellableAttributeInsert & { id: string }>) {
      await this.repository.createAttribute({
        id: row.id,
        entityId,
        locale: row.locale,
        title: row.title,
        subtitle: row.subtitle,
        description: row.description,
        richDescription: row.richDescription,
        seoTitle: row.seoTitle,
        seoDescription: row.seoDescription,
      }, ctx);
    }

    await this.repository.deleteCustomFieldsByEntityId(entityId, ctx);
    for (const row of snapshot.customFields as unknown as Array<SellableCustomFieldInsert & { id: string }>) {
      await this.repository.createCustomField({
        id: row.id,
        entityId,
        fieldName: row.fieldName,
        fieldType: row.fieldType,
        source: row.source,
        status: row.status,
        confidence: row.confidence,
        evidence: row.evidence,
        locale: row.locale,
        approvedAt: this.restoreDate(row.approvedAt),
        approvedBy: row.approvedBy,
        textValue: row.textValue,
        numberValue: row.numberValue,
        booleanValue: row.booleanValue,
        dateValue: this.restoreDate(row.dateValue),
        jsonValue: row.jsonValue,
        createdAt: this.restoreDate(row.createdAt) ?? new Date(),
        updatedAt: this.restoreDate(row.updatedAt) ?? new Date(),
      }, ctx);
    }

    await this.repository.deleteEntityCategoriesByEntityId(entityId, ctx);
    for (const row of snapshot.categories as unknown as Array<{ categoryId: string; sortOrder: number }>) {
      await this.repository.addEntityToCategory(entityId, row.categoryId, row.sortOrder, ctx);
    }

    await this.repository.deleteEntityBrandsByEntityId(entityId, ctx);
    for (const row of snapshot.brands as unknown as Array<{ brandId: string; sortOrder: number }>) {
      await this.repository.addEntityToBrand(entityId, row.brandId, row.sortOrder, ctx);
    }

    await this.repository.deleteEntityMediaByEntityId(entityId, ctx);
    for (const row of snapshot.media as unknown as Array<{
      mediaAssetId: string;
      variantId: string | null;
      role: "primary" | "gallery" | "thumbnail" | "video" | "document";
      sortOrder: number;
    }>) {
      await this.repository.createEntityMedia({
        entityId,
        mediaAssetId: row.mediaAssetId,
        role: row.role,
        sortOrder: row.sortOrder,
        variantId: row.variantId,
      }, ctx);
    }
  }

  async restoreEntityRevision(
    entityId: string,
    revisionId: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<CatalogEntityHydrated>> {
    try {
      return await this.withMutation(actor, ctx, async (txCtx) => {
        const revisionActor = actor ?? txCtx.actor;
        assertPermission(revisionActor, "catalog:update");
        const entity = await this.repository.findEntityById(entityId, txCtx);
        if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
        if (entity.organizationId !== resolveOrgId(revisionActor)) {
          return Err(new CommerceNotFoundError("Entity not found."));
        }
        if (entity.sourceStoreId != null) assertPermission(revisionActor, "catalog:sync");
        const revision = await this.repository.findRevisionById(entityId, revisionId, txCtx);
        if (!revision) return Err(new CommerceNotFoundError("Revision not found."));
        await this.applyRevisionSnapshot(entityId, revision.snapshot, txCtx);
        const restored = await this.entities.getById(
          entityId,
          { includeAttributes: true, includeCategories: true, includeBrands: true, includeMedia: true },
          revisionActor,
          txCtx,
        );
        if (!restored.ok) return restored;
        await this.captureRevision(entityId, revisionActor, "restore", txCtx, true);
        return restored;
      });
    } catch (error) {
      return Err(toCommerceError(error));
    }
  }

  async trimEntityRevisions(
    actor: Actor | null,
    olderThanDays = 90,
    ctx?: TxContext,
  ): Promise<Result<number>> {
    try {
      return await this.withMutation(actor, ctx, async (txCtx) => {
        const revisionActor = actor ?? txCtx.actor;
        assertPermission(revisionActor, "catalog:update");
        const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
        return Ok(await this.repository.deleteRevisionsOlderThan(resolveOrgId(revisionActor), cutoff, txCtx));
      });
    } catch (error) {
      return Err(toCommerceError(error));
    }
  }

  create(input: CreateEntityInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.entities.create(input, actor, txCtx);
      if (result.ok) await this.captureRevision(result.value.id, actor, "create", txCtx);
      return result;
    });
  }

  update(id: string, input: UpdateEntityInput, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.entities.update(id, input, actor, txCtx);
      if (result.ok) await this.captureRevision(id, actor, "update", txCtx);
      return result;
    });
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
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.entities.publish(id, actor, txCtx);
      if (result.ok) await this.captureRevision(id, actor, "update", txCtx);
      return result;
    });
  }

  archive(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.entities.archive(id, actor, txCtx);
      if (result.ok) await this.captureRevision(id, actor, "update", txCtx);
      return result;
    });
  }

  discontinue(id: string, actor: Actor | null, ctx?: TxContext): Promise<Result<CatalogEntityHydrated>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.entities.discontinue(id, actor, txCtx);
      if (result.ok) await this.captureRevision(id, actor, "update", txCtx);
      return result;
    });
  }

  setAttributes(entityId: string, locale: string, attrs: SetAttributesInput, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.entities.setAttributes(entityId, locale, attrs, actor, txCtx);
      if (result.ok) await this.captureRevision(entityId, actor, "update", txCtx);
      return result;
    });
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
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.categories.addToCategory(entityId, categoryId, actor, txCtx);
      if (result.ok) await this.captureRevision(entityId, actor, "update", txCtx);
      return result;
    });
  }

  removeFromCategory(entityId: string, categoryId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.categories.removeFromCategory(entityId, categoryId, actor, txCtx);
      if (result.ok) await this.captureRevision(entityId, actor, "update", txCtx);
      return result;
    });
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
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.brands.addToBrand(entityId, brandId, actor, txCtx);
      if (result.ok) await this.captureRevision(entityId, actor, "update", txCtx);
      return result;
    });
  }

  removeFromBrand(entityId: string, brandId: string, actor: Actor | null, ctx?: TxContext): Promise<Result<void>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const result = await this.brands.removeFromBrand(entityId, brandId, actor, txCtx);
      if (result.ok) await this.captureRevision(entityId, actor, "update", txCtx);
      return result;
    });
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

  quickCreateVariant(
    entityId: string,
    input: { options: Record<string, string>; sku?: string | undefined; barcode?: string | undefined },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ variant: Variant; created: boolean }>> {
    return this.entities.quickCreateVariant(entityId, input, actor, ctx);
  }

  bulkCreateVariants(
    entityId: string,
    input: { axes: Array<{ name: string; values: string[] }>; skuPrefix?: string | undefined },
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<{ created: Variant[]; skipped: number }>> {
    return this.entities.bulkCreateVariants(entityId, input, actor, ctx);
  }
}
