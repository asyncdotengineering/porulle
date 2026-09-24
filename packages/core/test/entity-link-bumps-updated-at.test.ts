/**
 * A change to an entity's LINKS — its categories, brand, media — must move the entity's
 * `updated_at` and notify `catalog.afterUpdate`, exactly as an attribute edit does (0.54.0).
 *
 * Categories and brand are indexed search facets and the hero image drives the image embedding.
 * These writers changed the link rows and moved nothing on the entity, and fired no hook, so a
 * re-categorised or re-branded product kept its old facets in the index forever.
 *
 * The controls matter as much: re-linking what is already linked writes nothing and moves nothing,
 * or every idempotent sync looks like an edit and re-projects the catalogue.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import { sellableEntities } from "../src/modules/catalog/schema.js";
import { mediaAssets } from "../src/modules/media/schema.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

const editor: Actor = {
  type: "user",
  userId: "link-editor",
  email: "links@test.local",
  name: "Link Editor",
  vendorId: null,
  organizationId: DEFAULT_ORG_ID,
  role: "admin",
  permissions: ["*:*"],
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("entity link changes move the entity's updated_at", () => {
  let kernel: ReturnType<typeof createKernel>;
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;
  const seen: Array<{ id: string; updatedAt: unknown; changedFieldPaths: unknown }> = [];

  beforeAll(async () => {
    const pglite = await createPGliteTestAdapter();
    db = pglite.db;
    cleanup = pglite.cleanup;
    kernel = createKernel(await createTestConfig({ databaseAdapter: pglite.adapter }));
    kernel.hooks.append("catalog.afterUpdate", async (args: { result: { id: string; updatedAt: unknown }; context: { context: Record<string, unknown> } }) => {
      seen.push({ id: args.result.id, updatedAt: args.result.updatedAt, changedFieldPaths: args.context.context.changedFieldPaths });
    });
  }, 60_000);

  afterAll(async () => { await cleanup(); });

  async function product(slug: string): Promise<string> {
    const created = await kernel.services.catalog.create({ type: "product", slug, attributes: { locale: "en", title: slug } }, editor);
    if (!created.ok) throw new Error(created.error.message);
    return created.value.id;
  }
  const updatedAt = async (id: string) =>
    (await db.select({ at: sellableEntities.updatedAt }).from(sellableEntities).where(eq(sellableEntities.id, id)))[0]?.at.getTime();

  /** Run `change`, then assert it bumped `updated_at` once and told afterUpdate the new value. */
  async function expectBump(id: string, paths: string[], change: () => Promise<{ ok: boolean }>) {
    const before = await updatedAt(id);
    await pause();
    const firedBefore = seen.length;
    const result = await change();
    expect(result.ok).toBe(true);
    const after = await updatedAt(id);
    expect(after).toBeGreaterThan(before ?? Infinity);
    const fired = seen.slice(firedBefore).filter((event) => event.id === id);
    expect(fired.map((event) => event.changedFieldPaths)).toEqual([paths]);
    expect(fired[0]?.updatedAt instanceof Date ? fired[0].updatedAt.getTime() : undefined).toBe(after);
  }

  /** Run `change`, then assert it moved nothing and fired nothing. */
  async function expectNoBump(id: string, change: () => Promise<{ ok: boolean }>) {
    const before = await updatedAt(id);
    await pause();
    const firedBefore = seen.length;
    const result = await change();
    expect(result.ok).toBe(true);
    expect(await updatedAt(id)).toBe(before);
    expect(seen.slice(firedBefore).filter((event) => event.id === id)).toEqual([]);
  }

  it("adding and removing a category bumps, and re-adding the same category does not", async () => {
    const id = await product("recategorised");
    const category = await kernel.services.catalog.createCategory({ slug: "trousers" }, editor);
    if (!category.ok) throw new Error(category.error.message);

    await expectBump(id, ["categories"], () => kernel.services.catalog.addToCategory(id, category.value.id, editor));
    await expectNoBump(id, () => kernel.services.catalog.addToCategory(id, category.value.id, editor));
    await expectBump(id, ["categories"], () => kernel.services.catalog.removeFromCategory(id, category.value.id, editor));
  });

  it("adding and removing a brand bumps, and re-adding the same brand does not", async () => {
    const id = await product("rebranded");
    const brand = await kernel.services.catalog.createBrand({ slug: "atelier", displayName: "Atelier" }, editor);
    if (!brand.ok) throw new Error(brand.error.message);

    await expectBump(id, ["brand"], () => kernel.services.catalog.addToBrand(id, brand.value.id, editor));
    await expectNoBump(id, () => kernel.services.catalog.addToBrand(id, brand.value.id, editor));
    await expectBump(id, ["brand"], () => kernel.services.catalog.removeFromBrand(id, brand.value.id, editor));
  });

  it("attaching media bumps, naming the role", async () => {
    const id = await product("new-hero");
    const [asset] = await db.insert(mediaAssets).values({
      organizationId: DEFAULT_ORG_ID, storageKey: "hero.jpg", filename: "hero.jpg", contentType: "image/jpeg", size: 1,
    }).returning({ id: mediaAssets.id });
    if (!asset) throw new Error("no media asset");

    await expectBump(id, ["media.primary"], () => kernel.services.media.attachToEntity({ entityId: id, mediaAssetId: asset.id, role: "primary" }, editor));
  });
});
