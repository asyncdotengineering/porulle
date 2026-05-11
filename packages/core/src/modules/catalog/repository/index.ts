import { eq, and, inArray, type SQL } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import {
  sellableEntities,
  sellableAttributes,
  sellableCustomFields,
  categories,
  entityCategories,
  brands,
  entityBrands,
  optionTypes,
  optionValues,
  variants,
  variantOptionValues,
} from "../schema.js";

// Infer types from Drizzle schema
export type SellableEntity = typeof sellableEntities.$inferSelect;
export type SellableEntityInsert = typeof sellableEntities.$inferInsert;
export type SellableAttribute = typeof sellableAttributes.$inferSelect;
export type SellableAttributeInsert = typeof sellableAttributes.$inferInsert;
export type SellableCustomField = typeof sellableCustomFields.$inferSelect;
export type SellableCustomFieldInsert =
  typeof sellableCustomFields.$inferInsert;
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
      .where(eq(sellableCustomFields.entityId, entityId));
  }

  async createCustomField(
    data: SellableCustomFieldInsert,
    ctx?: TxContext,
  ): Promise<SellableCustomField> {
    const db = this.getDb(ctx);
    const rows = await db.insert(sellableCustomFields).values(data).returning();
    return rows[0]!;
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

  async createVariant(data: VariantInsert, ctx?: TxContext): Promise<Variant> {
    const db = this.getDb(ctx);
    const rows = await db.insert(variants).values(data).returning();
    return rows[0]!;
  }

  async updateVariant(
    id: string,
    data: Partial<Omit<VariantInsert, "id">>,
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
