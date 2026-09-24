/**
 * `writeEntityLinks` is the link writer both bulk paths (page import, channel converge) share, and
 * it replaced service calls that refused another organization's entity or taxonomy. The refusal
 * now lives in the statement: a row naming another org's entity, category, brand, tag or media
 * asset writes nothing. And what it returns is exactly what changed — the caller versions from it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { organization } from "../src/auth/auth-schema.js";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { brands, categories, entityCategories, sellableEntities, tags } from "../src/modules/catalog/schema.js";
import { entityMedia, mediaAssets } from "../src/modules/media/schema.js";
import { linkFieldPaths, writeEntityLinks } from "../src/modules/catalog/entity-links.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

const OTHER_ORG = "links-other-org";

describe("writeEntityLinks", () => {
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ db, cleanup } = await createPGliteTestAdapter());
    await db.insert(organization).values({ id: OTHER_ORG, name: "Other", slug: "links-other", createdAt: new Date() });
  }, 60_000);
  afterAll(async () => { await cleanup(); });

  async function fixtures(orgId: string, suffix: string) {
    const [entity] = await db.insert(sellableEntities).values({ organizationId: orgId, type: "product", slug: `e-${suffix}` }).returning();
    const [category] = await db.insert(categories).values({ organizationId: orgId, slug: `c-${suffix}` }).returning();
    const [brand] = await db.insert(brands).values({ organizationId: orgId, slug: `b-${suffix}`, displayName: suffix }).returning();
    const [tag] = await db.insert(tags).values({ organizationId: orgId, slug: `t-${suffix}`, displayName: suffix }).returning();
    const [asset] = await db.insert(mediaAssets).values({
      organizationId: orgId, storageKey: `${suffix}.jpg`, filename: `${suffix}.jpg`, contentType: "image/jpeg", size: 1,
    }).returning();
    if (!entity || !category || !brand || !tag || !asset) throw new Error("fixture insert returned nothing");
    return { entity, category, brand, tag, asset };
  }

  it("writes an entity's links once and returns only what changed, with the paths the services use", async () => {
    const own = await fixtures(DEFAULT_ORG_ID, "own");
    const rows = {
      categories: [{ entityId: own.entity.id, categoryId: own.category.id, sortOrder: 0 }],
      brands: [{ entityId: own.entity.id, brandId: own.brand.id, sortOrder: 0 }],
      tags: [{ entityId: own.entity.id, tagId: own.tag.id }],
      media: [{ entityId: own.entity.id, variantId: null, mediaAssetId: own.asset.id, role: "primary" as const, sortOrder: 0 }],
    };

    const first = await writeEntityLinks(db, DEFAULT_ORG_ID, rows);
    expect(linkFieldPaths(first).get(own.entity.id)).toEqual(["brand", "categories", "media.primary", "tags"]);

    const again = await writeEntityLinks(db, DEFAULT_ORG_ID, {
      ...rows,
      mediaPlacements: [{ entityId: own.entity.id, variantId: null, mediaAssetId: own.asset.id, role: "primary", sortOrder: 0 }],
    });
    expect(linkFieldPaths(again).size).toBe(0);

    const moved = await writeEntityLinks(db, DEFAULT_ORG_ID, {
      mediaPlacements: [{ entityId: own.entity.id, variantId: null, mediaAssetId: own.asset.id, role: "gallery", sortOrder: 2 }],
    });
    expect(moved.placed.map((row) => ({ role: row.role, sortOrder: row.sortOrder }))).toEqual([{ role: "gallery", sortOrder: 2 }]);
  });

  it("refuses another organization's category, brand, tag or asset: nothing is written", async () => {
    const own = await fixtures(DEFAULT_ORG_ID, "mine");
    const foreign = await fixtures(OTHER_ORG, "theirs");

    const written = await writeEntityLinks(db, DEFAULT_ORG_ID, {
      categories: [{ entityId: own.entity.id, categoryId: foreign.category.id, sortOrder: 0 }],
      brands: [{ entityId: own.entity.id, brandId: foreign.brand.id, sortOrder: 0 }],
      tags: [{ entityId: own.entity.id, tagId: foreign.tag.id }],
      media: [{ entityId: own.entity.id, variantId: null, mediaAssetId: foreign.asset.id, role: "primary", sortOrder: 0 }],
    });

    expect(linkFieldPaths(written).size).toBe(0);
    expect(await db.select().from(entityCategories).where(eq(entityCategories.entityId, own.entity.id))).toEqual([]);
    expect(await db.select().from(entityMedia).where(eq(entityMedia.entityId, own.entity.id))).toEqual([]);
  });

  it("refuses another organization's entity, even with this organization's taxonomy", async () => {
    const own = await fixtures(DEFAULT_ORG_ID, "ours");
    const foreign = await fixtures(OTHER_ORG, "their-entity");
    await writeEntityLinks(db, OTHER_ORG, {
      media: [{ entityId: foreign.entity.id, variantId: null, mediaAssetId: foreign.asset.id, role: "primary", sortOrder: 0 }],
    });

    const written = await writeEntityLinks(db, DEFAULT_ORG_ID, {
      categories: [{ entityId: foreign.entity.id, categoryId: own.category.id, sortOrder: 0 }],
      mediaPlacements: [{ entityId: foreign.entity.id, variantId: null, mediaAssetId: foreign.asset.id, role: "gallery", sortOrder: 9 }],
    });

    expect(linkFieldPaths(written).size).toBe(0);
    expect(await db.select().from(entityCategories).where(eq(entityCategories.entityId, foreign.entity.id))).toEqual([]);
    expect((await db.select().from(entityMedia).where(eq(entityMedia.entityId, foreign.entity.id))).map((row) => row.role)).toEqual(["primary"]);
  });
});
