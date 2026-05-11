import { eq, and, inArray } from "drizzle-orm";
import type { TxContext } from "../../../kernel/database/tx-context.js";
import type {
  DrizzleDatabase,
  DbOrTx,
} from "../../../kernel/database/drizzle-db.js";
import { mediaAssets, entityMedia } from "../schema.js";

// Infer types from Drizzle schema
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type MediaAssetInsert = typeof mediaAssets.$inferInsert;
export type EntityMedia = typeof entityMedia.$inferSelect;
export type EntityMediaInsert = typeof entityMedia.$inferInsert;

/**
 * MediaRepository provides type-safe database operations for media assets.
 *
 * This repository manages media assets and their associations with entities.
 * All methods support an optional TxContext parameter for transaction participation.
 */
export class MediaRepository {
  constructor(private readonly db: DrizzleDatabase) {}

  private getDb(ctx?: TxContext): DbOrTx {
    return (ctx?.tx as DbOrTx | undefined) ?? this.db;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Media Assets
  // ─────────────────────────────────────────────────────────────────────────────

  async findAssetById(
    id: string,
    ctx?: TxContext,
    orgId?: string,
  ): Promise<MediaAsset | undefined> {
    const db = this.getDb(ctx);
    const conditions = [eq(mediaAssets.id, id)];
    if (orgId) {
      conditions.push(eq(mediaAssets.organizationId, orgId));
    }
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(and(...conditions));
    return rows[0];
  }

  async findAssetByStorageKey(
    storageKey: string,
    ctx?: TxContext,
  ): Promise<MediaAsset | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.storageKey, storageKey));
    return rows[0];
  }

  async findAssetsByIds(ids: string[], ctx?: TxContext): Promise<MediaAsset[]> {
    if (ids.length === 0) return [];
    const db = this.getDb(ctx);
    return db.select().from(mediaAssets).where(inArray(mediaAssets.id, ids));
  }

  async createAsset(
    data: MediaAssetInsert,
    ctx?: TxContext,
  ): Promise<MediaAsset> {
    const db = this.getDb(ctx);
    const rows = await db.insert(mediaAssets).values(data).returning();
    return rows[0]!;
  }

  async updateAsset(
    id: string,
    data: Partial<Omit<MediaAssetInsert, "id">>,
    ctx?: TxContext,
  ): Promise<MediaAsset | undefined> {
    const db = this.getDb(ctx);
    const rows = await db
      .update(mediaAssets)
      .set(data)
      .where(eq(mediaAssets.id, id))
      .returning();
    return rows[0];
  }

  async deleteAsset(id: string, ctx?: TxContext): Promise<boolean> {
    const db = this.getDb(ctx);
    const result = await db
      .delete(mediaAssets)
      .where(eq(mediaAssets.id, id))
      .returning();
    return result.length > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Entity Media (Associations)
  // ─────────────────────────────────────────────────────────────────────────────

  async findEntityMedia(
    entityId: string,
    variantId?: string,
    ctx?: TxContext,
  ): Promise<EntityMedia[]> {
    const db = this.getDb(ctx);

    if (variantId === undefined) {
      // Find media for entity only (not variant-specific)
      const rows = await db
        .select()
        .from(entityMedia)
        .where(eq(entityMedia.entityId, entityId));
      return rows.filter((r) => r.variantId === null);
    }

    return db
      .select()
      .from(entityMedia)
      .where(
        and(
          eq(entityMedia.entityId, entityId),
          eq(entityMedia.variantId, variantId),
        ),
      );
  }

  async findEntityMediaByRole(
    entityId: string,
    role: EntityMedia["role"],
    variantId?: string,
    ctx?: TxContext,
  ): Promise<EntityMedia[]> {
    const db = this.getDb(ctx);
    const conditions = [
      eq(entityMedia.entityId, entityId),
      eq(entityMedia.role, role),
    ];

    if (variantId !== undefined) {
      conditions.push(eq(entityMedia.variantId, variantId));
    }

    const rows = await db
      .select()
      .from(entityMedia)
      .where(and(...conditions));

    if (variantId === undefined) {
      return rows.filter((r) => r.variantId === null);
    }
    return rows;
  }

  async findPrimaryMedia(
    entityId: string,
    variantId?: string,
    ctx?: TxContext,
  ): Promise<EntityMedia | undefined> {
    const media = await this.findEntityMediaByRole(
      entityId,
      "primary",
      variantId,
      ctx,
    );
    return media[0];
  }

  async createEntityMedia(
    data: EntityMediaInsert,
    ctx?: TxContext,
  ): Promise<EntityMedia> {
    const db = this.getDb(ctx);
    const rows = await db.insert(entityMedia).values(data).returning();
    return rows[0]!;
  }

  async createEntityMediaBatch(
    data: EntityMediaInsert[],
    ctx?: TxContext,
  ): Promise<EntityMedia[]> {
    if (data.length === 0) return [];
    const db = this.getDb(ctx);
    return db.insert(entityMedia).values(data).returning();
  }

  async updateEntityMediaSortOrder(
    entityId: string,
    mediaAssetId: string,
    sortOrder: number,
    variantId?: string,
    ctx?: TxContext,
  ): Promise<EntityMedia | undefined> {
    const db = this.getDb(ctx);
    const conditions = [
      eq(entityMedia.entityId, entityId),
      eq(entityMedia.mediaAssetId, mediaAssetId),
    ];

    if (variantId !== undefined) {
      conditions.push(eq(entityMedia.variantId, variantId));
    }

    const rows = await db
      .update(entityMedia)
      .set({ sortOrder })
      .where(and(...conditions))
      .returning();

    if (variantId === undefined) {
      return rows.find((r) => r.variantId === null);
    }
    return rows[0];
  }

  async removeEntityMedia(
    entityId: string,
    mediaAssetId: string,
    variantId?: string,
    ctx?: TxContext,
  ): Promise<boolean> {
    const db = this.getDb(ctx);
    const conditions = [
      eq(entityMedia.entityId, entityId),
      eq(entityMedia.mediaAssetId, mediaAssetId),
    ];

    if (variantId !== undefined) {
      conditions.push(eq(entityMedia.variantId, variantId));
    }

    const result = await db
      .delete(entityMedia)
      .where(and(...conditions))
      .returning();

    if (variantId === undefined) {
      return result.some((r) => r.variantId === null);
    }
    return result.length > 0;
  }

  async removeAllEntityMedia(entityId: string, ctx?: TxContext): Promise<void> {
    const db = this.getDb(ctx);
    await db.delete(entityMedia).where(eq(entityMedia.entityId, entityId));
  }

  async removeAllMediaByAssetId(
    mediaAssetId: string,
    ctx?: TxContext,
  ): Promise<void> {
    const db = this.getDb(ctx);
    await db
      .delete(entityMedia)
      .where(eq(entityMedia.mediaAssetId, mediaAssetId));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Aggregates
  // ─────────────────────────────────────────────────────────────────────────────

  async findAssetsForEntity(
    entityId: string,
    variantId?: string,
    ctx?: TxContext,
  ): Promise<MediaAsset[]> {
    const associations = await this.findEntityMedia(entityId, variantId, ctx);
    const assetIds = associations.map((a) => a.mediaAssetId);
    if (assetIds.length === 0) return [];
    return this.findAssetsByIds(assetIds, ctx);
  }
}
