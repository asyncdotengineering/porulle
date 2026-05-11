import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const ORG_A = "org_media_a";
const ORG_B = "org_media_b";

const adminA: Actor = {
  type: "user",
  userId: "media-admin-a",
  email: "a@media.test",
  name: "Media Admin A",
  vendorId: null,
  organizationId: ORG_A,
  role: "admin",
  permissions: ["*:*"],
};

const adminB: Actor = {
  type: "user",
  userId: "media-admin-b",
  email: "b@media.test",
  name: "Media Admin B",
  vendorId: null,
  organizationId: ORG_B,
  role: "admin",
  permissions: ["*:*"],
};

describe("media attach cross-tenant isolation", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let entityAId: string;
  let entityBId: string;
  let assetAId: string;
  let assetBId: string;

  beforeAll(async () => {
    kernel = await createTestKernel();

    const db = kernel.database.db as {
      insert: (t: unknown) => {
        values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> };
      };
    };
    await db.insert(organization).values([
      { id: ORG_A, name: "Media Tenant A", slug: "media-a", createdAt: new Date() },
      { id: ORG_B, name: "Media Tenant B", slug: "media-b", createdAt: new Date() },
    ]).onConflictDoNothing();

    const createdA = await kernel.services.catalog.create(
      { type: "product", slug: "media-entity-a", metadata: {} },
      adminA,
    );
    const createdB = await kernel.services.catalog.create(
      { type: "product", slug: "media-entity-b", metadata: {} },
      adminB,
    );
    expect(createdA.ok).toBe(true);
    expect(createdB.ok).toBe(true);
    if (!createdA.ok || !createdB.ok) {
      throw new Error("Failed to create media test entities.");
    }
    entityAId = createdA.value.id;
    entityBId = createdB.value.id;

    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47,
      0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
    ]);
    const uploadedA = await kernel.services.media.upload(
      {
        filename: "a.png",
        contentType: "image/png",
        data: png.buffer,
      },
      adminA,
    );
    const uploadedB = await kernel.services.media.upload(
      {
        filename: "b.png",
        contentType: "image/png",
        data: png.buffer,
      },
      adminB,
    );
    expect(uploadedA.ok).toBe(true);
    expect(uploadedB.ok).toBe(true);
    if (!uploadedA.ok || !uploadedB.ok) {
      throw new Error("Failed to upload media test assets.");
    }
    assetAId = uploadedA.value.id;
    assetBId = uploadedB.value.id;
  });

  it("returns NOT_FOUND when actor org cannot access target entity", async () => {
    const result = await kernel.services.media.attachToEntity(
      {
        entityId: entityAId,
        mediaAssetId: assetBId,
        role: "gallery",
      },
      adminB,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns NOT_FOUND when actor org cannot access target asset", async () => {
    const result = await kernel.services.media.attachToEntity(
      {
        entityId: entityBId,
        mediaAssetId: assetAId,
        role: "gallery",
      },
      adminB,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("still allows same-org attach", async () => {
    const result = await kernel.services.media.attachToEntity(
      {
        entityId: entityBId,
        mediaAssetId: assetBId,
        role: "primary",
      },
      adminB,
    );
    expect(result.ok).toBe(true);
  });
});
