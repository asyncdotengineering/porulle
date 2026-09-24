import { and, eq, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { PluginDb } from "../../kernel/database/plugin-types.js";
import { mediaAssets, entityMedia } from "../media/schema.js";
import { brands, categories, entityBrands, entityCategories, entityTags, sellableEntities, tags } from "./schema.js";

/**
 * THE writer of an entity's link rows — categories, brand, tags, media — for the bulk paths: the
 * page import (`importProducts`) and the channel converge, both of which write links directly
 * rather than one service call per link.
 *
 * - One statement per link class, however many entities the rows span.
 * - Org scope is enforced IN the statement: a row whose entity, or whose category / brand / tag /
 *   media asset, belongs to another organization matches nothing and is not written. Callers
 *   resolve ids within their org already; this makes a slip a no-write instead of a cross-org link.
 * - Idempotent: a link that already exists is not rewritten and is not returned. What comes back
 *   is exactly what changed, which is what a caller versions the entity from (`linkFieldPaths`).
 */
export type EntityMediaRole = (typeof entityMedia.$inferInsert)["role"];

export interface EntityLinkRows {
  categories?: ReadonlyArray<{ entityId: string; categoryId: string; sortOrder: number }>;
  brands?: ReadonlyArray<{ entityId: string; brandId: string; sortOrder: number }>;
  tags?: ReadonlyArray<{ entityId: string; tagId: string }>;
  /** New media links. */
  media?: ReadonlyArray<{ entityId: string; variantId: string | null; mediaAssetId: string; role: EntityMediaRole; sortOrder: number }>;
  /** Existing media links whose role or sort order should become these; unchanged ones write nothing. */
  mediaPlacements?: ReadonlyArray<{ entityId: string; variantId: string | null; mediaAssetId: string; role: EntityMediaRole; sortOrder: number }>;
}

export interface WrittenEntityLinks {
  categories: Array<typeof entityCategories.$inferSelect>;
  brands: Array<typeof entityBrands.$inferSelect>;
  tags: Array<typeof entityTags.$inferSelect>;
  media: Array<typeof entityMedia.$inferSelect>;
  placed: Array<typeof entityMedia.$inferSelect>;
}

const valuesOf = (rows: ReadonlyArray<readonly SQL[]>): SQL =>
  sql.join(rows.map((row) => sql`(${sql.join([...row], sql`, `)})`), sql`, `);

const entityInOrg = (orgId: string): SQL =>
  sql`join ${sellableEntities} on ${sellableEntities.id} = v.entity_id and ${sellableEntities.organizationId} = ${orgId}`;

export async function writeEntityLinks(
  db: Pick<PluginDb, "insert" | "update">,
  orgId: string,
  rows: EntityLinkRows,
): Promise<WrittenEntityLinks> {
  const written: WrittenEntityLinks = { categories: [], brands: [], tags: [], media: [], placed: [] };
  if (rows.categories?.length) {
    written.categories = await db.insert(entityCategories).select(sql`
      select v.entity_id, v.category_id, v.sort_order
      from (values ${valuesOf(rows.categories.map((row) => [sql`${row.entityId}::uuid`, sql`${row.categoryId}::uuid`, sql`${row.sortOrder}::integer`]))})
        as v(entity_id, category_id, sort_order)
      join ${categories} on ${categories.id} = v.category_id and ${categories.organizationId} = ${orgId}
      ${entityInOrg(orgId)}`).onConflictDoNothing().returning();
  }
  if (rows.brands?.length) {
    written.brands = await db.insert(entityBrands).select(sql`
      select v.entity_id, v.brand_id, v.sort_order
      from (values ${valuesOf(rows.brands.map((row) => [sql`${row.entityId}::uuid`, sql`${row.brandId}::uuid`, sql`${row.sortOrder}::integer`]))})
        as v(entity_id, brand_id, sort_order)
      join ${brands} on ${brands.id} = v.brand_id and ${brands.organizationId} = ${orgId}
      ${entityInOrg(orgId)}`).onConflictDoNothing().returning();
  }
  if (rows.tags?.length) {
    written.tags = await db.insert(entityTags).select(sql`
      select v.entity_id, v.tag_id
      from (values ${valuesOf(rows.tags.map((row) => [sql`${row.entityId}::uuid`, sql`${row.tagId}::uuid`]))})
        as v(entity_id, tag_id)
      join ${tags} on ${tags.id} = v.tag_id and ${tags.organizationId} = ${orgId}
      ${entityInOrg(orgId)}`).onConflictDoNothing().returning();
  }
  if (rows.media?.length) {
    written.media = await db.insert(entityMedia).select(sql`
      select v.entity_id, v.variant_id, v.media_asset_id, v.role, v.sort_order, now()
      from (values ${valuesOf(rows.media.map((row) => [
        sql`${row.entityId}::uuid`, sql`${row.variantId}::uuid`, sql`${row.mediaAssetId}::uuid`, sql`${row.role}::text`, sql`${row.sortOrder}::integer`,
      ]))}) as v(entity_id, variant_id, media_asset_id, role, sort_order)
      join ${mediaAssets} on ${mediaAssets.id} = v.media_asset_id and ${mediaAssets.organizationId} = ${orgId}
      ${entityInOrg(orgId)}`).onConflictDoNothing().returning();
  }
  // ponytail: one UPDATE per re-placed link; a role/sort change upstream is rare, batch it if a
  // store ever reshuffles whole galleries on every sync.
  for (const row of rows.mediaPlacements ?? []) {
    written.placed.push(...await db.update(entityMedia).set({ role: row.role, sortOrder: row.sortOrder }).where(and(
      eq(entityMedia.entityId, row.entityId),
      eq(entityMedia.mediaAssetId, row.mediaAssetId),
      row.variantId === null ? isNull(entityMedia.variantId) : eq(entityMedia.variantId, row.variantId),
      or(ne(entityMedia.role, row.role), ne(entityMedia.sortOrder, row.sortOrder)),
      sql`exists (select 1 from ${sellableEntities} where ${sellableEntities.id} = ${entityMedia.entityId} and ${sellableEntities.organizationId} = ${orgId})`,
    )).returning());
  }
  return written;
}

/**
 * The field paths each entity's written links changed, sorted — the names the catalog services
 * version links under (`categories`, `brand`, `tags`, `media.<role>`), so a consumer sees the same
 * paths whichever path wrote the link.
 */
export function linkFieldPaths(written: WrittenEntityLinks): Map<string, string[]> {
  const byEntity = new Map<string, Set<string>>();
  const add = (entityId: string, path: string) => {
    const paths = byEntity.get(entityId) ?? new Set<string>();
    paths.add(path);
    byEntity.set(entityId, paths);
  };
  for (const row of written.categories) add(row.entityId, "categories");
  for (const row of written.brands) add(row.entityId, "brand");
  for (const row of written.tags) add(row.entityId, "tags");
  for (const row of [...written.media, ...written.placed]) add(row.entityId, `media.${row.role}`);
  return new Map([...byEntity].map(([entityId, paths]) => [entityId, [...paths].sort()]));
}
