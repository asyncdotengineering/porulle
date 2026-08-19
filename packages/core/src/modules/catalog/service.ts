import type { Actor } from "../../auth/types.js";
import { resolveOrgId } from "../../auth/org.js";
import { assertPermission } from "../../auth/permissions.js";
import type { CommerceConfig } from "../../config/types.js";
import type { EntityFieldDefinition, FieldType } from "../../config/types.js";
import type { HookRegistry } from "../../kernel/hooks/registry.js";
import { Err, Ok, type Result } from "../../kernel/result.js";
import { CommerceConflictError, CommerceNotFoundError, CommerceValidationError, toCommerceError } from "../../kernel/errors.js";
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
  type SellableCustomField,
  type SellableCustomFieldInsert,
  type EntityFieldDefinitionRecord,
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
  includeCustomFields?: boolean;
}

export interface VariantMatrixRule {
  include?: string[][];
  exclude?: string[][];
}

export type VariantGenerationStrategy =
  | { mode: "all" }
  | { mode: "manual"; combinations: string[][] }
  | { mode: "matrix"; matrix: VariantMatrixRule };

export type EntityFieldDefinitionResolver = (
  entityType: string,
  actorOrOrg?: Actor | string | null,
  ctx?: TxContext,
) => Promise<EntityFieldDefinition[]>;

export type CreateEntityFieldDefinitionInput = {
  entityType: string;
  name: string;
  type: FieldType;
  unit?: string | null;
  options?: string[] | null;
  target?: string | null;
  filterable?: boolean;
  localized?: boolean;
  sortOrder?: number;
};

export type UpdateEntityFieldDefinitionInput = Partial<Omit<CreateEntityFieldDefinitionInput, "entityType" | "name">> & {
  entityType?: string;
  name?: string;
};

export interface CatalogEntityHydrated extends SellableEntity {
  attributes?: SellableAttribute[];
  customFields?: SellableCustomField[];
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
  approveCustomField(
    entityId: string,
    fieldName: string,
    locale: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<SellableCustomField>>;
  rejectCustomField(
    entityId: string,
    fieldName: string,
    locale: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<SellableCustomField>>;
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
  listEntityFieldDefinitions(
    actor?: Actor | null,
    entityType?: string,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord[]>>;
  createEntityFieldDefinition(
    input: CreateEntityFieldDefinitionInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord>>;
  updateEntityFieldDefinition(
    id: string,
    input: UpdateEntityFieldDefinitionInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord>>;
  archiveEntityFieldDefinition(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord>>;
  resolveEntityFieldDefinitions: EntityFieldDefinitionResolver;
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
  private readonly config: CommerceConfig;
  private readonly entities: EntityService;
  private readonly categories: CategoryService;
  private readonly brands: BrandService;

  constructor(deps: CatalogServiceDeps) {
    this.repository = deps.repository;
    this.database = deps.database;
    this.config = deps.config;
    this.entities = new EntityService(deps, this.resolveEntityFieldDefinitions.bind(this));
    this.categories = new CategoryService(deps);
    this.brands = new BrandService(deps);
  }

  private codeFieldDefinition(entityType: string, name: string): EntityFieldDefinition | undefined {
    return this.config.entities?.[entityType]?.fields.find((field) => field.name === name);
  }

  private runtimeFieldDefinition(row: EntityFieldDefinitionRecord): EntityFieldDefinition {
    return {
      name: row.name,
      type: row.type,
      ...(row.unit != null ? { unit: row.unit } : {}),
      ...(row.options != null ? { options: row.options } : {}),
      ...(row.target != null ? { target: row.target } : {}),
      filterable: row.filterable,
      localized: row.localized,
      sortOrder: row.sortOrder,
    };
  }

  async resolveEntityFieldDefinitions(
    entityType: string,
    actorOrOrg?: Actor | string | null,
    ctx?: TxContext,
  ): Promise<EntityFieldDefinition[]> {
    const orgId = typeof actorOrOrg === "string"
      ? actorOrOrg
      : resolveOrgId(actorOrOrg ?? ctx?.actor ?? null);
    const codeFields = this.config.entities?.[entityType]?.fields ?? [];
    const merged = new Map(codeFields.map((field) => [field.name, { ...field }]));
    const runtimeFields = await this.repository.findActiveEntityFieldDefinitions(orgId, entityType, ctx);

    for (const row of runtimeFields) {
      const codeField = merged.get(row.name);
      if (!codeField) {
        merged.set(row.name, this.runtimeFieldDefinition(row));
        continue;
      }
      merged.set(row.name, {
        ...codeField,
        ...(row.options != null ? { options: row.options } : {}),
        filterable: row.filterable,
        localized: row.localized,
        sortOrder: row.sortOrder,
      });
    }

    return [...merged.values()].sort((first, second) =>
      (first.sortOrder ?? 0) - (second.sortOrder ?? 0),
    );
  }

  listEntityFieldDefinitions(
    actor?: Actor | null,
    entityType?: string,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord[]>> {
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return this.withMutationResult(actor ?? ctx?.actor ?? null, ctx, async (txCtx) =>
      Ok(await this.repository.findEntityFieldDefinitions(orgId, entityType, txCtx)),
    );
  }

  createEntityFieldDefinition(
    input: CreateEntityFieldDefinitionInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord>> {
    if (input.entityType.length === 0 || input.name.length === 0) {
      return Promise.resolve(Err(new CommerceValidationError("Entity type and field name are required.")));
    }
    assertPermission(actor, "catalog:update");
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const codeField = this.codeFieldDefinition(input.entityType, input.name);
      if (codeField && input.type !== codeField.type) {
        return Err(new CommerceValidationError("Code-defined fields only allow options, filterable, localized, and sortOrder overrides."));
      }
      return Ok(await this.repository.createEntityFieldDefinition({
        organizationId: orgId,
        entityType: input.entityType,
        name: input.name,
        type: input.type,
        // A shadow row over a code field inherits the code values for anything
        // omitted, so creating one never silently flips a code default.
        ...(codeField?.unit !== undefined || input.unit !== undefined
          ? { unit: codeField ? codeField.unit ?? null : input.unit }
          : {}),
        ...(codeField?.target !== undefined || input.target !== undefined
          ? { target: codeField ? codeField.target ?? null : input.target }
          : {}),
        ...(input.options !== undefined
          ? { options: input.options }
          : codeField?.options !== undefined ? { options: codeField.options } : {}),
        ...(input.filterable !== undefined
          ? { filterable: input.filterable }
          : codeField?.filterable !== undefined ? { filterable: codeField.filterable } : {}),
        ...(input.localized !== undefined ? { localized: input.localized } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      }, txCtx));
    });
  }

  updateEntityFieldDefinition(
    id: string,
    input: UpdateEntityFieldDefinitionInput,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord>> {
    assertPermission(actor, "catalog:update");
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const existing = await this.repository.findEntityFieldDefinitionById(orgId, id, txCtx);
      if (!existing) return Err(new CommerceNotFoundError("Entity field definition not found."));
      const codeField = this.codeFieldDefinition(existing.entityType, existing.name);
      if (codeField && (input.entityType !== undefined || input.name !== undefined || input.type !== undefined || input.unit !== undefined || input.target !== undefined)) {
        return Err(new CommerceValidationError("Code-defined fields only allow options, filterable, localized, and sortOrder updates."));
      }
      const data = {
        ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(input.options !== undefined ? { options: input.options } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.filterable !== undefined ? { filterable: input.filterable } : {}),
        ...(input.localized !== undefined ? { localized: input.localized } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      };
      const updated = await this.repository.updateEntityFieldDefinition(orgId, id, data, txCtx);
      if (!updated) return Err(new CommerceNotFoundError("Entity field definition not found."));
      return Ok(updated);
    });
  }

  archiveEntityFieldDefinition(
    id: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<EntityFieldDefinitionRecord>> {
    assertPermission(actor, "catalog:update");
    const orgId = resolveOrgId(actor ?? ctx?.actor ?? null);
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const existing = await this.repository.findEntityFieldDefinitionById(orgId, id, txCtx);
      if (!existing) return Err(new CommerceNotFoundError("Entity field definition not found."));
      if (this.codeFieldDefinition(existing.entityType, existing.name)) {
        return Err(new CommerceValidationError("Code-defined fields cannot be archived."));
      }
      if (existing.status === "archived") return Ok(existing);
      const updated = await this.repository.updateEntityFieldDefinition(orgId, id, { status: "archived" }, txCtx);
      if (!updated) return Err(new CommerceNotFoundError("Entity field definition not found."));
      return Ok(updated);
    });
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
      if (isUniqueViolation(error)) return Err(new CommerceConflictError("A resource with those values already exists."));
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

    // Snapshots written before tags existed carry no key; restoring one must
    // not delete tag links the snapshot never saw.
    if (snapshot.tags) {
      await this.repository.deleteEntityTagsByEntityId(entityId, ctx);
      for (const row of snapshot.tags as unknown as Array<{ tagId: string }>) {
        await this.repository.addEntityTag(entityId, row.tagId, ctx);
      }
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

  private reviewCustomField(
    status: "approved" | "rejected",
    entityId: string,
    fieldName: string,
    locale: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<SellableCustomField>> {
    return this.withMutationResult(actor, ctx, async (txCtx) => {
      const reviewer = actor ?? txCtx.actor;
      assertPermission(reviewer, "catalog:update");
      const entity = await this.repository.findEntityById(entityId, txCtx);
      if (!entity) return Err(new CommerceNotFoundError("Entity not found."));
      if (entity.organizationId !== resolveOrgId(reviewer)) {
        return Err(new CommerceNotFoundError("Entity not found."));
      }
      if (entity.sourceStoreId != null) assertPermission(reviewer, "catalog:sync");
      const proposal = await this.repository.findProposedCustomField(entityId, fieldName, locale, txCtx);
      if (!proposal) return Err(new CommerceNotFoundError("Custom field proposal not found."));
      if (status === "approved") {
        await this.repository.deleteCustomField(entityId, fieldName, locale, txCtx);
      }
      const updated = await this.repository.updateProposedCustomField(proposal.id, {
        status,
        ...(status === "approved"
          ? { approvedAt: new Date(), approvedBy: reviewer?.userId ?? null }
          : {}),
      }, txCtx);
      // Throw, never return Err, past this point: the approved-row delete above
      // must roll back when the proposal was already resolved by a concurrent
      // reviewer, or the live value is lost with no replacement.
      if (!updated) throw new CommerceNotFoundError("Custom field proposal not found.");
      if (status === "approved") {
        await this.repository.rejectOtherProposedCustomFields(entityId, fieldName, locale, updated.id, txCtx);
      }
      await this.captureRevision(entityId, reviewer, "update", txCtx);
      return Ok(updated);
    });
  }

  approveCustomField(
    entityId: string,
    fieldName: string,
    locale: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<SellableCustomField>> {
    return this.reviewCustomField("approved", entityId, fieldName, locale, actor, ctx);
  }

  rejectCustomField(
    entityId: string,
    fieldName: string,
    locale: string,
    actor: Actor | null,
    ctx?: TxContext,
  ): Promise<Result<SellableCustomField>> {
    return this.reviewCustomField("rejected", entityId, fieldName, locale, actor, ctx);
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
