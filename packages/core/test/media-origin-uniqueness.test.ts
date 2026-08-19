import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Actor } from "../src/auth/types.js";
import { entityMedia, mediaAssets } from "../src/modules/media/schema.js";
import { assertMediaWritable } from "../src/modules/media/service.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

const adminActor: Actor = {
  type: "user",
  userId: "media-origin-admin",
  email: "media-origin-admin@local.test",
  name: "Media Origin Admin",
  vendorId: null,
  organizationId: "org_default",
  role: "admin",
  permissions: ["*:*"],
};

const nonMerchantActor: Actor = {
  type: "user",
  userId: "media-origin-agent",
  email: "media-origin-agent@local.test",
  name: "Media Origin Agent",
  vendorId: null,
  organizationId: "org_default",
  role: "agent",
  permissions: [],
};

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);

describe("media origin and entity association uniqueness", () => {
  let kernel: ReturnType<typeof createKernel>;
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createPGliteTestConfig();
    kernel = createKernel(built.config);
    db = kernel.database.db as DrizzleDatabase;
    cleanup = built.cleanup;
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  async function createEntityAndAsset() {
    const entityResult = await kernel.services.catalog.create(
      { type: "product", slug: `media-origin-${Date.now()}-${Math.random()}`, metadata: {} },
      adminActor,
    );
    expect(entityResult.ok).toBe(true);
    if (!entityResult.ok) throw entityResult.error;

    const uploadResult = await kernel.services.media.upload(
      {
        filename: "merchant.png",
        contentType: "image/png",
        data: png.buffer,
      },
      adminActor,
    );
    expect(uploadResult.ok).toBe(true);
    if (!uploadResult.ok) throw uploadResult.error;

    const assetRows = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, uploadResult.value.id));
    const asset = assetRows[0];
    if (!asset) throw new Error("Uploaded media asset was not persisted.");

    return { entityId: entityResult.value.id, asset };
  }

  it("defaults existing upload paths to merchant-owned media", async () => {
    const { asset } = await createEntityAndAsset();

    expect(asset.origin).toBe("merchant");
    expect(asset.confidence).toBeNull();
    expect(asset.derivedFromAssetId).toBeNull();
  });

  it("accepts an explicit imported origin for future convergence callers", async () => {
    const uploadResult = await kernel.services.media.upload(
      {
        filename: "imported.png",
        contentType: "image/png",
        data: png.buffer,
        origin: "imported",
      },
      adminActor,
    );
    expect(uploadResult.ok).toBe(true);
    if (!uploadResult.ok) throw uploadResult.error;

    const assetRows = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, uploadResult.value.id));
    expect(assetRows[0]?.origin).toBe("imported");
  });

  it("allows the same asset at entity level and variant level", async () => {
    const { entityId, asset } = await createEntityAndAsset();
    const variantResult = await kernel.services.catalog.createVariant(
      { entityId, options: {} },
      adminActor,
    );
    expect(variantResult.ok).toBe(true);
    if (!variantResult.ok) throw variantResult.error;

    const entityLevel = await kernel.services.media.attachToEntity(
      { entityId, mediaAssetId: asset.id, role: "gallery" },
      adminActor,
    );
    const variantLevel = await kernel.services.media.attachToEntity(
      {
        entityId,
        mediaAssetId: asset.id,
        role: "gallery",
        variantId: variantResult.value.id,
      },
      adminActor,
    );

    expect(entityLevel.ok).toBe(true);
    expect(variantLevel.ok).toBe(true);

    const links = await db
      .select()
      .from(entityMedia)
      .where(eq(entityMedia.entityId, entityId));
    expect(links).toHaveLength(2);
    expect(links.some((link) => link.variantId === null)).toBe(true);
    expect(links.some((link) => link.variantId === variantResult.value.id)).toBe(true);
  });

  it("rejects a duplicate asset attach at the variant level", async () => {
    const { entityId, asset } = await createEntityAndAsset();
    const variantResult = await kernel.services.catalog.createVariant(
      { entityId, options: {} },
      adminActor,
    );
    expect(variantResult.ok).toBe(true);
    if (!variantResult.ok) throw variantResult.error;

    const first = await kernel.services.media.attachToEntity(
      { entityId, mediaAssetId: asset.id, role: "gallery", variantId: variantResult.value.id },
      adminActor,
    );
    expect(first.ok).toBe(true);

    const duplicate = await kernel.services.media.attachToEntity(
      { entityId, mediaAssetId: asset.id, role: "thumbnail", variantId: variantResult.value.id },
      adminActor,
    );
    expect(duplicate.ok).toBe(false);

    const links = await db
      .select()
      .from(entityMedia)
      .where(eq(entityMedia.entityId, entityId));
    expect(links).toHaveLength(1);
  });

  it("rejects a duplicate asset attach at the same level", async () => {
    const { entityId, asset } = await createEntityAndAsset();

    const first = await kernel.services.media.attachToEntity(
      { entityId, mediaAssetId: asset.id, role: "gallery" },
      adminActor,
    );
    const duplicate = await kernel.services.media.attachToEntity(
      { entityId, mediaAssetId: asset.id, role: "gallery" },
      adminActor,
    );

    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
  });

  it("rejects a non-merchant actor from writing merchant-owned media", async () => {
    const { asset } = await createEntityAndAsset();

    expect(() => assertMediaWritable(asset, nonMerchantActor)).toThrow();
  });

  it("guards deletion of merchant-owned media", async () => {
    const { asset } = await createEntityAndAsset();

    const result = await kernel.services.media.delete(asset.id, nonMerchantActor);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");

    const remaining = await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, asset.id));
    expect(remaining).toHaveLength(1);
  });
});
