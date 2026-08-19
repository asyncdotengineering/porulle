import { eq, and, asc, count, desc, gt, inArray, isNull, lt, max, ne, or, type SQL } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import { CommerceNotFoundError } from "../../../kernel/errors.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import {
  sellableEntities,
  sellableAttributes,
  sellableCustomFields,
  entityFieldDefinitions,
  categories,
  entityCategories,
  brands,
  entityBrands,
  entityTags,
  optionTypes,
  optionValues,
  variants,
  variantOptionValues,
  sellableEntityRevisions,
  catalogFieldOwnership,
  type SellableEntityRevisionSnapshot,
} from "../schema.js";
import { entityMedia } from "../../media/schema.js";

// Infer types from Drizzle schema
export type SellableEntity = typeof sellableEntities.$inferSelect;
export type SellableEntityInsert = typeof sellableEntities.$inferInsert;
export type SellableAttribute = typeof sellableAttributes.$inferSelect;
export type SellableAttributeInsert = typeof sellableAttributes.$inferInsert;
export type SellableCustomField = typeof sellableCustomFields.$inferSelect;
export type SellableCustomFieldInsert =
  typeof sellableCustomFields.$inferInsert;
export type EntityFieldDefinitionRecord = typeof entityFieldDefinitions.$inferSelect;
export type EntityFieldDefinitionInsert = typeof entityFieldDefinitions.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type CategoryInsert = typeof categories.$inferInsert;
export type EntityCategory = typeof entityCategories.$inferSelect;
export type EntityCategoryInsert = typeof entityCategories.$inferInsert;
export type Brand = typeof brands.$inferSelect;
export type BrandInsert = typeof brands.$inferInsert;
export type EntityBrand = typeof entityBrands.$inferSelect;
export type EntityBrandInsert = typeof entityBrands.$inferInsert;
export type OptionType = typeof optionTypes.$inferSelect;
export type OptionTypeInsert = typeof optionTypes.$inferInsert;
export type OptionValue = typeof optionValues.$inferSelect;
export type OptionValueInsert = typeof optionValues.$inferInsert;
export type Variant = typeof variants.$inferSelect;
export type VariantInsert = typeof variants.$inferInsert;
export type VariantOptionValue = typeof variantOptionValues.$inferSelect;
export type VariantOptionValueInsert = typeof variantOptionValues.$inferInsert;
export type SellableEntityRevision = typeof sellableEntityRevisions.$inferSelect;
export type SellableEntityRevisionInsert = typeof sellableEntityRevisions.$inferInsert;
export type CatalogFieldOwnership = typeof catalogFieldOwnership.$inferSelect;
export type CatalogFieldOwnershipInsert = typeof catalogFieldOwnership.$inferInsert;
export type ProposedCustomField = SellableCustomField & {
  entitySlug: string;
  entityType: string;
};

/**
 * CatalogRepository provides type-safe database operations for catalog entities.
 *
 * This repository uses Drizzle ORM with PostgresJsDatabase for full type inference.
 * Transaction context is passed through TxContext when needed for transactional writes.
 *
 * All methods support an optional TxContext parameter for transaction participation.
 * When ctx is provided, operations run within that transaction; otherwise they use the main db.
 */
export class CatalogRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  /**
   * Returns the appropriate database context - either a transaction or the main db.
   * Both DrizzleDatabase and DrizzleTx have the same query builder interface.
   */
  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sellable Entities
  // ─────────────────────────────────────────────────────────────────────────────

  async findEntityById(
    id: string,
    ctx?: TxContext,
    orgId?: string,
  ): Promise<SellableEntity | undefined> {
    const db = this.getDb(ctx);
    const conditions = [eq(sellableEntities.id, id)];
    if (orgId) {
      conditions.push(eq(sellableEntities.organizationId, orgId));
    }
    const rows = await db
      .select()
      .from(sellableEntities)
      .where(and(...conditions));
    return rows[0];
  }

  async findEntityBySlug(
    orgId: string,
    slug: string,
    ctx?: TxContext,
  ): Promise<SellableEntity | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(sellableEntities)
      .where(
        and(
          eq(sellableEntities.organizationId, orgId),
          eq(sellableEntities.slug, slug),
        ),
      );
    return rows[0];
  }

  async findEntities(
    orgId: string,
    filter?: {
      type?: string;
      status?: string;
      ids?: string[];
    },
    ctx?: TxContext,
  ): Promise<SellableEntity[]> {
    const db = this.getDb(ctx);
    const conditions: SQL[] = [eq(sellableEntities.organizationId, orgId)];

    if (filter?.type) {
      conditions.push(eq(sellableEntities.type, filter.type));
    }
    if (filter?.status) {
      conditions.push(
        eq(sellableEntities.status, filter.status as SellableEntity["status"]),
      );
    }
    if (filter?.ids && filter.ids.length > 0) {
      conditions.push(inArray(sellableEntities.id, filter.ids));
    }

    return db
      .select()
      .from(sellableEntities)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions));
  }

  async createEntity(
    data: SellableEntityInsert,
    ctx?: TxContext,
  ): Promise<SellableEntity> {
    const db = this.getDb(ctx);
    const rows = await db.insert(sellableEntities).values(data).returning();
    return rows[0]!;
  }

  async updateEntity(
    id: string,
    data: Partial<Omit<SellableEntityInsert, "id">>,
    ctx?: TxContext,
  ): Promise<SellableEntity | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(sellableEntities)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sellableEntities.id, id))
      .returning();
    return rows[0];
  }

  async deleteEntity(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(sellableEntities)
      .where(eq(sellableEntities.id, id))
      .returning();
    return result.length > 0;
  }

  async findFieldOwnership(
    entityId: string,
    ctx?: TxContext,
    storeId?: string,
  ): Promise<CatalogFieldOwnership[]> {
    const db = this.getDb(ctx);
    const conditions = [eq(catalogFieldOwnership.entityId, entityId)];
    if (storeId !== undefined) {
      conditions.push(or(isNull(catalogFieldOwnership.storeId), eq(catalogFieldOwnership.storeId, storeId))!);
    }
    return db
      .select()
      .from(catalogFieldOwnership)
      .where(and(...conditions))
      .orderBy(asc(catalogFieldOwnership.fieldPath), asc(catalogFieldOwnership.updatedAt));
  }

  async findFieldOwnershipForResolution(
    entityId: string,
    storeId: string,
    variantId: string | null,
    ctx?: TxContext,
  ): Promise<CatalogFieldOwnership[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(catalogFieldOwnership)
      .where(and(
        eq(catalogFieldOwnership.entityId, entityId),
        or(isNull(catalogFieldOwnership.storeId), eq(catalogFieldOwnership.storeId, storeId)),
        variantId == null
          ? isNull(catalogFieldOwnership.variantId)
          : or(isNull(catalogFieldOwnership.variantId), eq(catalogFieldOwnership.variantId, variantId)),
      ));
  }

  async upsertFieldOwnership(
    data: CatalogFieldOwnershipInsert,
    ctx?: TxContext,
  ): Promise<CatalogFieldOwnership> {
    const db = this.getDb(ctx);
    const rows = await db
      .insert(catalogFieldOwnership)
      .values(data)
      .onConflictDoUpdate({
        target: [
          catalogFieldOwnership.organizationId,
          catalogFieldOwnership.entityId,
          catalogFieldOwnership.variantId,
          catalogFieldOwnership.storeId,
          catalogFieldOwnership.fieldPath,
        ],
        set: {
          owner: data.owner,
          updatedAt: data.updatedAt ?? new Date(),
        },
      })
      .returning();
    return rows[0]!;
  }

  async seedFieldOwnership(
    data: CatalogFieldOwnershipInsert[],
    ctx?: TxContext,
  ): Promise<void> {
    if (data.length === 0) return;
    const db = this.getDb(ctx);
    await db.insert(catalogFieldOwnership).values(data).onConflictDoNothing();
  }

  async findRevisionsByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<SellableEntityRevision[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(sellableEntityRevisions)
      .where(eq(sellableEntityRevisions.entityId, entityId))
      .orderBy(asc(sellableEntityRevisions.revision));
  }

  async findLatestRevision(
    entityId: string,
    ctx?: TxContext,
  ): Promise<SellableEntityRevision | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(sellableEntityRevisions)
      .where(eq(sellableEntityRevisions.entityId, entityId))
      .orderBy(desc(sellableEntityRevisions.revision))
      .limit(1);
    return rows[0];
  }

  async findRevisionById(
    entityId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<SellableEntityRevision | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(sellableEntityRevisions)
      .where(
        and(
          eq(sellableEntityRevisions.entityId, entityId),
          eq(sellableEntityRevisions.id, id),
        ),
      );
    return rows[0];
  }

  async createRevision(
    data: Omit<SellableEntityRevisionInsert, "id" | "revision" | "pinned">,
    ctx?: TxContext,
  ): Promise<SellableEntityRevision> {
    const db = this.getDb(ctx);
    const rows = await db
      .select({ revision: max(sellableEntityRevisions.revision) })
      .from(sellableEntityRevisions)
      .where(eq(sellableEntityRevisions.entityId, data.entityId));
    const revision = (rows[0]?.revision ?? 0) + 1;
    const inserted = await db
      .insert(sellableEntityRevisions)
      .values({
        ...data,
        revision,
        pinned: revision === 1,
      })
      .returning();
    return inserted[0]!;
  }

  async updateRevision(
    id: string,
    data: Partial<Pick<SellableEntityRevisionInsert, "createdAt" | "pinned">>,
    ctx?: TxContext,
  ): Promise<SellableEntityRevision | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(sellableEntityRevisions)
      .set(data)
      .where(eq(sellableEntityRevisions.id, id))
      .returning();
    return rows[0];
  }

  async deleteRevisionsOlderThan(
    organizationId: string,
    cutoff: Date,
    ctx?: TxContext,
  ): Promise<number> {
    const db = this.getDb(ctx);
    const deleted = await db
      .delete(sellableEntityRevisions)
      .where(
        and(
          eq(sellableEntityRevisions.organizationId, organizationId),
          lt(sellableEntityRevisions.createdAt, cutoff),
          eq(sellableEntityRevisions.pinned, false),
          gt(sellableEntityRevisions.revision, 1),
        ),
      )
      .returning({ id: sellableEntityRevisions.id });
    return deleted.length;
  }

  async snapshotEntity(
    entityId: string,
    ctx?: TxContext,
  ): Promise<SellableEntityRevisionSnapshot> {
    const entity = await this.findEntityById(entityId, ctx);
    if (!entity) throw new CommerceNotFoundError("Entity not found.");
    const [attributes, customFields, categoriesForEntity, brandsForEntity, media, tagsForEntity] = await Promise.all([
      this.findAttributesByEntityId(entityId, ctx),
      this.findAllCustomFieldsByEntityId(entityId, ctx),
      this.findEntityCategories(entityId, ctx),
      this.findEntityBrands(entityId, ctx),
      this.findEntityMedia(entityId, ctx),
      this.findEntityTags(entityId, ctx),
    ]);
    return {
      entity: entity as unknown as Record<string, unknown>,
      attributes: attributes.sort((a, b) => a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id)) as unknown as Array<Record<string, unknown>>,
      customFields: customFields.sort((a, b) => a.locale.localeCompare(b.locale) || a.fieldName.localeCompare(b.fieldName) || a.id.localeCompare(b.id)) as unknown as Array<Record<string, unknown>>,
      media: media.sort((a, b) => a.mediaAssetId.localeCompare(b.mediaAssetId) || (a.variantId ?? "").localeCompare(b.variantId ?? "")) as unknown as Array<Record<string, unknown>>,
      categories: categoriesForEntity.sort((a, b) => a.categoryId.localeCompare(b.categoryId)) as unknown as Array<Record<string, unknown>>,
      brands: brandsForEntity.sort((a, b) => a.brandId.localeCompare(b.brandId)) as unknown as Array<Record<string, unknown>>,
      tags: tagsForEntity.sort((a, b) => a.tagId.localeCompare(b.tagId)) as unknown as Array<Record<string, unknown>>,
    };
  }

  async findEntityMedia(
    entityId: string,
    ctx?: TxContext,
  ): Promise<Array<typeof entityMedia.$inferSelect>> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(entityMedia)
      .where(eq(entityMedia.entityId, entityId));
  }

  async deleteEntityMediaByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(entityMedia).where(eq(entityMedia.entityId, entityId));
  }

  async createEntityMedia(
    data: typeof entityMedia.$inferInsert,
    ctx?: TxContext,
  ): Promise<typeof entityMedia.$inferSelect> {
    const db = this.getDb(ctx);
    const rows = await db.insert(entityMedia).values(data).returning();
    return rows[0]!;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sellable Attributes
  // ─────────────────────────────────────────────────────────────────────────────

  async findAttributesByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<SellableAttribute[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(sellableAttributes)
      .where(eq(sellableAttributes.entityId, entityId));
  }

  async findAttributeByLocale(
    entityId: string,
    locale: string,
    ctx?: TxContext,
  ): Promise<SellableAttribute | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(sellableAttributes)
      .where(
        and(
          eq(sellableAttributes.entityId, entityId),
          eq(sellableAttributes.locale, locale),
        ),
      );
    return rows[0];
  }

  async createAttribute(
    data: SellableAttributeInsert,
    ctx?: TxContext,
  ): Promise<SellableAttribute> {
    const db = this.getDb(ctx);
    const rows = await db.insert(sellableAttributes).values(data).returning();
    return rows[0]!;
  }

  async updateAttribute(
    id: string,
    data: Partial<Omit<SellableAttributeInsert, "id">>,
    ctx?: TxContext,
  ): Promise<SellableAttribute | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(sellableAttributes)
      .set(data)
      .where(eq(sellableAttributes.id, id))
      .returning();
    return rows[0];
  }

  async upsertAttribute(
    entityId: string,
    locale: string,
    data: Omit<SellableAttributeInsert, "entityId" | "locale">,
    ctx?: TxContext,
  ): Promise<SellableAttribute> {
    const existing = await this.findAttributeByLocale(entityId, locale, ctx);
    if (existing) {
      const updated = await this.updateAttribute(existing.id, data, ctx);
      return updated!;
    }
    return this.createAttribute({ ...data, entityId, locale }, ctx);
  }

  async deleteAttributesByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(sellableAttributes)
      .where(eq(sellableAttributes.entityId, entityId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Custom Fields
  // ─────────────────────────────────────────────────────────────────────────────

  async findCustomFieldsByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<SellableCustomField[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(sellableCustomFields)
      .where(
        and(
          eq(sellableCustomFields.entityId, entityId),
          eq(sellableCustomFields.status, "approved"),
        ),
      );
  }

  async findAllCustomFieldsByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<SellableCustomField[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(sellableCustomFields)
      .where(eq(sellableCustomFields.entityId, entityId));
  }

  async findProposedCustomField(
    entityId: string,
    fieldName: string,
    locale = "en",
    ctx?: TxContext,
  ): Promise<SellableCustomField | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(sellableCustomFields)
      .where(
        and(
          eq(sellableCustomFields.entityId, entityId),
          eq(sellableCustomFields.fieldName, fieldName),
          eq(sellableCustomFields.locale, locale),
          eq(sellableCustomFields.status, "proposed"),
        ),
      )
      .orderBy(desc(sellableCustomFields.createdAt), desc(sellableCustomFields.id))
      .limit(1);
    return rows[0];
  }

  async updateProposedCustomField(
    id: string,
    data: Partial<Omit<SellableCustomFieldInsert, "id">>,
    ctx?: TxContext,
  ): Promise<SellableCustomField | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(sellableCustomFields)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(sellableCustomFields.id, id),
          eq(sellableCustomFields.status, "proposed"),
        ),
      )
      .returning();
    return rows[0];
  }

  async rejectOtherProposedCustomFields(
    entityId: string,
    fieldName: string,
    locale: string,
    excludeId: string,
    ctx?: TxContext,
  ): Promise<number> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(sellableCustomFields)
      .set({ status: "rejected", updatedAt: new Date() })
      .where(
        and(
          eq(sellableCustomFields.entityId, entityId),
          eq(sellableCustomFields.fieldName, fieldName),
          eq(sellableCustomFields.locale, locale),
          eq(sellableCustomFields.status, "proposed"),
          ne(sellableCustomFields.id, excludeId),
        ),
      )
      .returning({ id: sellableCustomFields.id });
    return rows.length;
  }

  async listProposedCustomFields(
    organizationId: string,
    pagination: { page: number; limit: number },
    filter?: { entityType?: string },
    ctx?: TxContext,
  ): Promise<{ items: ProposedCustomField[]; total: number }> {
    const db = this.getDb(ctx);
    const page = Math.max(1, pagination.page);
    const limit = Math.max(1, pagination.limit);
    const conditions: SQL[] = [
      eq(sellableCustomFields.status, "proposed"),
      eq(sellableEntities.organizationId, organizationId),
    ];
    if (filter?.entityType !== undefined) {
      conditions.push(eq(sellableEntities.type, filter.entityType));
    }
    const where = and(...conditions);
    const rows = await db
      .select({
        customField: sellableCustomFields,
        entitySlug: sellableEntities.slug,
        entityType: sellableEntities.type,
      })
      .from(sellableCustomFields)
      .innerJoin(sellableEntities, eq(sellableCustomFields.entityId, sellableEntities.id))
      .where(where)
      .orderBy(asc(sellableCustomFields.createdAt), asc(sellableCustomFields.id))
      .limit(limit)
      .offset((page - 1) * limit);
    const totalRows = await db
      .select({ count: count() })
      .from(sellableCustomFields)
      .innerJoin(sellableEntities, eq(sellableCustomFields.entityId, sellableEntities.id))
      .where(where);
    return {
      items: rows.map(({ customField, entitySlug, entityType }) => ({
        ...customField,
        entitySlug,
        entityType,
      })),
      total: totalRows[0]?.count ?? 0,
    };
  }

  async findCustomFieldByName(
    entityId: string,
    fieldName: string,
    locale = "en",
    ctx?: TxContext,
  ): Promise<SellableCustomField | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(sellableCustomFields)
      .where(
        and(
          eq(sellableCustomFields.entityId, entityId),
          eq(sellableCustomFields.fieldName, fieldName),
          eq(sellableCustomFields.locale, locale),
          eq(sellableCustomFields.status, "approved"),
        ),
      );
    return rows[0];
  }

  async createCustomField(
    data: SellableCustomFieldInsert,
    ctx?: TxContext,
  ): Promise<SellableCustomField> {
    const db = this.getDb(ctx);
    const rows = await db.insert(sellableCustomFields).values(data).returning();
    return rows[0]!;
  }

  async updateCustomField(
    id: string,
    data: Partial<Omit<SellableCustomFieldInsert, "id">>,
    ctx?: TxContext,
  ): Promise<SellableCustomField | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(sellableCustomFields)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sellableCustomFields.id, id))
      .returning();
    return rows[0];
  }

  async upsertCustomField(
    entityId: string,
    fieldName: string,
    locale: string,
    data: Omit<SellableCustomFieldInsert, "entityId" | "fieldName">,
    ctx?: TxContext,
  ): Promise<SellableCustomField> {
    const existing = await this.findCustomFieldByName(entityId, fieldName, locale, ctx);
    if (existing) {
      const updated = await this.updateCustomField(existing.id, data, ctx);
      return updated!;
    }
    return this.createCustomField({ ...data, entityId, fieldName, locale }, ctx);
  }

  async deleteCustomField(
    entityId: string,
    fieldName: string,
    locale = "en",
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(sellableCustomFields)
      .where(
        and(
          eq(sellableCustomFields.entityId, entityId),
          eq(sellableCustomFields.fieldName, fieldName),
          eq(sellableCustomFields.locale, locale),
          eq(sellableCustomFields.status, "approved"),
        ),
      );
  }

  async deleteCustomFieldsByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(sellableCustomFields)
      .where(eq(sellableCustomFields.entityId, entityId));
  }

  async findEntityFieldDefinitions(
    organizationId: string,
    entityType?: string,
    ctx?: TxContext,
  ): Promise<EntityFieldDefinitionRecord[]> {
    const db = this.getDb(ctx);
    const conditions = [eq(entityFieldDefinitions.organizationId, organizationId)];
    if (entityType !== undefined) {
      conditions.push(eq(entityFieldDefinitions.entityType, entityType));
    }
    return db
      .select()
      .from(entityFieldDefinitions)
      .where(and(...conditions))
      .orderBy(asc(entityFieldDefinitions.entityType), asc(entityFieldDefinitions.sortOrder), asc(entityFieldDefinitions.name));
  }

  async findActiveEntityFieldDefinitions(
    organizationId: string,
    entityType: string,
    ctx?: TxContext,
  ): Promise<EntityFieldDefinitionRecord[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(entityFieldDefinitions)
      .where(
        and(
          eq(entityFieldDefinitions.organizationId, organizationId),
          eq(entityFieldDefinitions.entityType, entityType),
          eq(entityFieldDefinitions.status, "active"),
        ),
      )
      .orderBy(asc(entityFieldDefinitions.sortOrder), asc(entityFieldDefinitions.name));
  }

  async findEntityFieldDefinitionById(
    organizationId: string,
    id: string,
    ctx?: TxContext,
  ): Promise<EntityFieldDefinitionRecord | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(entityFieldDefinitions)
      .where(and(eq(entityFieldDefinitions.organizationId, organizationId), eq(entityFieldDefinitions.id, id)));
    return rows[0];
  }

  async createEntityFieldDefinition(
    data: EntityFieldDefinitionInsert,
    ctx?: TxContext,
  ): Promise<EntityFieldDefinitionRecord> {
    const db = this.getDb(ctx);
    const rows = await db.insert(entityFieldDefinitions).values(data).returning();
    return rows[0]!;
  }

  async updateEntityFieldDefinition(
    organizationId: string,
    id: string,
    data: Partial<Omit<EntityFieldDefinitionInsert, "id" | "organizationId">>,
    ctx?: TxContext,
  ): Promise<EntityFieldDefinitionRecord | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(entityFieldDefinitions)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(entityFieldDefinitions.organizationId, organizationId), eq(entityFieldDefinitions.id, id)))
      .returning();
    return rows[0];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Categories
  // ─────────────────────────────────────────────────────────────────────────────

  async findCategoryById(
    id: string,
    ctx?: TxContext,
  ): Promise<Category | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(categories)
      .where(eq(categories.id, id));
    return rows[0];
  }

  async findCategoryBySlug(
    orgId: string,
    slug: string,
    ctx?: TxContext,
  ): Promise<Category | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.organizationId, orgId),
          eq(categories.slug, slug),
        ),
      );
    return rows[0];
  }

  async findAllCategories(
    orgId: string,
    ctx?: TxContext,
  ): Promise<Category[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(categories)
      .where(eq(categories.organizationId, orgId));
  }

  async createCategory(
    data: CategoryInsert,
    ctx?: TxContext,
  ): Promise<Category> {
    const db = this.getDb(ctx);
    const rows = await db.insert(categories).values(data).returning();
    return rows[0]!;
  }

  async updateCategory(
    id: string,
    data: Partial<Omit<CategoryInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Category | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(categories)
      .set(data)
      .where(eq(categories.id, id))
      .returning();
    return rows[0];
  }

  async deleteCategory(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(categories)
      .where(eq(categories.id, id))
      .returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Entity Categories (Join Table)
  // ─────────────────────────────────────────────────────────────────────────────

  async findEntityCategories(
    entityId: string,
    ctx?: TxContext,
  ): Promise<EntityCategory[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(entityCategories)
      .where(eq(entityCategories.entityId, entityId));
  }

  async findEntitiesByCategory(
    categoryId: string,
    ctx?: TxContext,
  ): Promise<string[]> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(entityCategories)
      .where(eq(entityCategories.categoryId, categoryId));
    return rows.map((r) => r.entityId);
  }

  async addEntityToCategory(
    entityId: string,
    categoryId: string,
    sortOrder = 0,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .insert(entityCategories)
      .values({ entityId, categoryId, sortOrder })
      .onConflictDoNothing();
  }

  async removeEntityFromCategory(
    entityId: string,
    categoryId: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(entityCategories)
      .where(
        and(
          eq(entityCategories.entityId, entityId),
          eq(entityCategories.categoryId, categoryId),
        ),
      )
      .returning();
    return result.length > 0;
  }

  async deleteEntityCategoriesByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(entityCategories)
      .where(eq(entityCategories.entityId, entityId));
  }

  async deleteEntityCategoriesByCategoryId(
    categoryId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(entityCategories)
      .where(eq(entityCategories.categoryId, categoryId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Brands
  // ─────────────────────────────────────────────────────────────────────────────

  async findBrandById(id: string, ctx?: TxContext): Promise<Brand | undefined> {
    const db = this.getDb(ctx);
    const rows = await db.select().from(brands).where(eq(brands.id, id));
    return rows[0];
  }

  async findBrandBySlug(
    orgId: string,
    slug: string,
    ctx?: TxContext,
  ): Promise<Brand | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(brands)
      .where(
        and(
          eq(brands.organizationId, orgId),
          eq(brands.slug, slug),
        ),
      );
    return rows[0];
  }

  async findAllBrands(orgId: string, ctx?: TxContext): Promise<Brand[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(brands)
      .where(eq(brands.organizationId, orgId));
  }

  async createBrand(data: BrandInsert, ctx?: TxContext): Promise<Brand> {
    const db = this.getDb(ctx);
    const rows = await db.insert(brands).values(data).returning();
    return rows[0]!;
  }

  async updateBrand(
    id: string,
    data: Partial<Omit<BrandInsert, "id">>,
    ctx?: TxContext,
  ): Promise<Brand | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(brands)
      .set(data)
      .where(eq(brands.id, id))
      .returning();
    return rows[0];
  }

  async deleteBrand(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db.delete(brands).where(eq(brands.id, id)).returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Entity Brands (Join Table)
  // ─────────────────────────────────────────────────────────────────────────────

  async findEntityBrands(
    entityId: string,
    ctx?: TxContext,
  ): Promise<EntityBrand[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(entityBrands)
      .where(eq(entityBrands.entityId, entityId));
  }

  async findEntityTags(
    entityId: string,
    ctx?: TxContext,
  ): Promise<Array<typeof entityTags.$inferSelect>> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(entityTags)
      .where(eq(entityTags.entityId, entityId));
  }

  async addEntityTag(entityId: string, tagId: string, ctx?: TxContext): Promise<void> {
    const db = this.getDb(ctx);
    await db.insert(entityTags).values({ entityId, tagId }).onConflictDoNothing();
  }

  async deleteEntityTagsByEntityId(entityId: string, ctx?: TxContext): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(entityTags).where(eq(entityTags.entityId, entityId));
  }

  async addEntityToBrand(
    entityId: string,
    brandId: string,
    sortOrder = 0,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .insert(entityBrands)
      .values({ entityId, brandId, sortOrder })
      .onConflictDoNothing();
  }

  async removeEntityFromBrand(
    entityId: string,
    brandId: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(entityBrands)
      .where(
        and(
          eq(entityBrands.entityId, entityId),
          eq(entityBrands.brandId, brandId),
        ),
      )
      .returning();
    return result.length > 0;
  }

  async deleteEntityBrandsByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(entityBrands).where(eq(entityBrands.entityId, entityId));
  }

  async deleteEntityBrandsByBrandId(
    brandId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(entityBrands).where(eq(entityBrands.brandId, brandId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Option Types
  // ─────────────────────────────────────────────────────────────────────────────

  async findOptionTypesByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<OptionType[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(optionTypes)
      .where(eq(optionTypes.entityId, entityId));
  }

  async findOptionTypeById(
    id: string,
    ctx?: TxContext,
  ): Promise<OptionType | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(optionTypes)
      .where(eq(optionTypes.id, id));
    return rows[0];
  }

  async createOptionType(
    data: OptionTypeInsert,
    ctx?: TxContext,
  ): Promise<OptionType> {
    const db = this.getDb(ctx);
    const rows = await db.insert(optionTypes).values(data).returning();
    return rows[0]!;
  }

  async deleteOptionTypesByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(optionTypes).where(eq(optionTypes.entityId, entityId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Option Values
  // ─────────────────────────────────────────────────────────────────────────────

  async findOptionValuesByTypeId(
    optionTypeId: string,
    ctx?: TxContext,
  ): Promise<OptionValue[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(optionValues)
      .where(eq(optionValues.optionTypeId, optionTypeId));
  }

  async findOptionValueById(
    id: string,
    ctx?: TxContext,
  ): Promise<OptionValue | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(optionValues)
      .where(eq(optionValues.id, id));
    return rows[0];
  }

  async findOptionValuesByIds(
    ids: string[],
    ctx?: TxContext,
  ): Promise<OptionValue[]> {
    if (ids.length === 0) return [];
    const db = this.getDb(ctx);
    return db.select().from(optionValues).where(inArray(optionValues.id, ids));
  }

  async createOptionValue(
    data: OptionValueInsert,
    ctx?: TxContext,
  ): Promise<OptionValue> {
    const db = this.getDb(ctx);
    const rows = await db.insert(optionValues).values(data).returning();
    return rows[0]!;
  }

  async deleteOptionValuesByTypeId(
    optionTypeId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(optionValues)
      .where(eq(optionValues.optionTypeId, optionTypeId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Variants
  // ─────────────────────────────────────────────────────────────────────────────

  async findVariantsByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<Variant[]> {
    const db = this.getDb(ctx);
    return db.select().from(variants).where(eq(variants.entityId, entityId));
  }

  async findVariantById(
    id: string,
    ctx?: TxContext,
  ): Promise<Variant | undefined> {
    const db = this.getDb(ctx);
    const rows = await db.select().from(variants).where(eq(variants.id, id));
    return rows[0];
  }

  async findVariantBySku(
    sku: string,
    ctx?: TxContext,
  ): Promise<Variant | undefined> {
    const db = this.getDb(ctx);
    const rows = await db.select().from(variants).where(eq(variants.sku, sku));
    return rows[0];
  }

  async findVariantByBarcode(
    barcode: string,
    ctx?: TxContext,
  ): Promise<Variant | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(variants)
      .where(eq(variants.barcode, barcode));
    return rows[0];
  }

  async createVariant(
    data: Omit<VariantInsert, "organizationId" | "sourceStoreId">,
    ctx?: TxContext,
  ): Promise<Variant> {
    const db = this.getDb(ctx);
    const entity = await this.findEntityById(data.entityId, ctx);
    if (!entity) throw new CommerceNotFoundError("Entity not found.");
    const rows = await db.insert(variants).values({
      ...data,
      organizationId: entity.organizationId,
      sourceStoreId: entity.sourceStoreId,
    }).returning();
    return rows[0]!;
  }

  async updateVariant(
    id: string,
    data: Partial<Omit<VariantInsert, "id" | "organizationId" | "sourceStoreId">>,
    ctx?: TxContext,
  ): Promise<Variant | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(variants)
      .set(data)
      .where(eq(variants.id, id))
      .returning();
    return rows[0];
  }

  async deleteVariantsByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(variants).where(eq(variants.entityId, entityId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Variant Option Values (Join Table)
  // ─────────────────────────────────────────────────────────────────────────────

  async findVariantOptionValues(
    variantId: string,
    ctx?: TxContext,
  ): Promise<VariantOptionValue[]> {
    const db = this.getDb(ctx);
    return db
      .select()
      .from(variantOptionValues)
      .where(eq(variantOptionValues.variantId, variantId));
  }

  async createVariantOptionValues(
    data: VariantOptionValueInsert[],
    ctx?: TxContext,
  ): Promise<void> {
    if (data.length === 0) return;
    const db = this.getDb(ctx);
    await db.insert(variantOptionValues).values(data).onConflictDoNothing();
  }

  async deleteVariantOptionValuesByVariantId(
    variantId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(variantOptionValues)
      .where(eq(variantOptionValues.variantId, variantId));
  }

  async deleteVariantOptionValuesByEntityId(
    entityId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    // Get all variant IDs for this entity first
    const entityVariants = await this.findVariantsByEntityId(entityId, ctx);
    const variantIds = entityVariants.map((v) => v.id);
    if (variantIds.length > 0) {
      await db
        .delete(variantOptionValues)
        .where(inArray(variantOptionValues.variantId, variantIds));
    }
  }
}
