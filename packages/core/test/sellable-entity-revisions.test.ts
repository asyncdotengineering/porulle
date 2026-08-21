import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTxContext } from "../src/kernel/database/tx-context.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const staff: Actor = {
  type: "user",
  userId: "sellable-revisions-staff",
  email: "sellable-revisions-staff@example.com",
  name: "Sellable Revisions Staff",
  vendorId: null,
  organizationId: "org_default",
  role: "staff",
  permissions: ["catalog:create", "catalog:update", "catalog:read", "catalog:read:unpublished"],
};

describe("sellable entity revisions", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createPGliteTestConfig();
    cleanup = built.cleanup;
    kernel = createKernel(built.config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("stores the complete created entity state as revision one", async () => {
    const result = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "revision-one",
        metadata: { source: "test" },
        attributes: {
          locale: "en",
          title: "Revision One",
          description: "The first state",
        },
        customFields: { weight: 2 },
      },
      staff,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(result.value.id);

    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      organizationId: "org_default",
      entityId: result.value.id,
      revision: 1,
      reason: "create",
      pinned: true,
      actorId: staff.userId,
      actorType: "user",
    });
    expect(revisions[0]?.snapshot).toMatchObject({
      entity: expect.objectContaining({
        id: result.value.id,
        slug: "revision-one",
        metadata: { source: "test" },
      }),
      attributes: [
        expect.objectContaining({
          locale: "en",
          title: "Revision One",
          description: "The first state",
        }),
      ],
      customFields: [
        expect.objectContaining({
          fieldName: "weight",
          numberValue: 2,
          status: "approved",
        }),
      ],
      media: [],
      categories: [],
      brands: [],
    });
  });

  it("skips an identical snapshot and records the next distinct entity state", async () => {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "identical-state",
        metadata: { title: "Original" },
      },
      staff,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const unchanged = await kernel.services.catalog.update(
      created.value.id,
      { metadata: { title: "Original" } },
      staff,
    );
    expect(unchanged.ok).toBe(true);

    let revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    expect(revisions).toHaveLength(1);

    const changed = await kernel.services.catalog.update(
      created.value.id,
      { metadata: { title: "Changed" } },
      staff,
    );
    expect(changed.ok).toBe(true);

    revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]).toMatchObject({ revision: 2, reason: "update" });
    expect(revisions[1]?.snapshot).toMatchObject({
      entity: expect.objectContaining({ metadata: { title: "Changed" } }),
    });
  });

  it("captures attribute, custom-field, category, and brand mutations", async () => {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "catalog-mutations",
      },
      staff,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    expect(
      (await kernel.services.catalog.setAttributes(created.value.id, "fr", {
        title: "Produit",
        description: "Description française",
      }, staff)).ok,
    ).toBe(true);
    expect(
      (await kernel.services.catalog.update(created.value.id, {
        customFields: { weight: 3 },
      }, staff)).ok,
    ).toBe(true);
    expect(
      (await kernel.services.catalog.addToCategory(created.value.id, "shoes", staff)).ok,
    ).toBe(true);
    expect(
      (await kernel.services.catalog.addToBrand(created.value.id, "nike", staff)).ok,
    ).toBe(true);

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);

    expect(revisions).toHaveLength(5);
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2, 3, 4, 5]);
    expect(revisions[2]?.snapshot).toMatchObject({
      customFields: [expect.objectContaining({ fieldName: "weight", numberValue: 3 })],
    });
    expect(revisions[3]?.snapshot).toMatchObject({
      categories: [expect.objectContaining({ categoryId: expect.any(String) })],
    });
    expect(revisions[4]?.snapshot).toMatchObject({
      brands: [expect.objectContaining({ brandId: expect.any(String) })],
    });
  });

  it("captures media associations in the same catalog state history", async () => {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "media-mutation",
      },
      staff,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const uploaded = await kernel.services.media.upload({
      filename: "cover.png",
      contentType: "image/png",
      data: new TextEncoder().encode("test-image").buffer,
    }, staff);
    expect(uploaded.ok).toBe(true);
    if (!uploaded.ok) throw uploaded.error;

    const attached = await kernel.services.media.attachToEntity({
      entityId: created.value.id,
      mediaAssetId: uploaded.value.id,
      role: "primary",
    }, staff);
    if (!attached.ok) throw attached.error;

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);

    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.snapshot).toMatchObject({
      media: [
        expect.objectContaining({
          entityId: created.value.id,
          mediaAssetId: uploaded.value.id,
          role: "primary",
        }),
      ],
    });
  });

  it("restores a selected state and appends a reversible restore revision", async () => {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "restore-me",
        metadata: { title: "Original" },
        attributes: { title: "Original title" },
        customFields: { weight: 1 },
      },
      staff,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const changed = await kernel.services.catalog.update(created.value.id, {
      metadata: { title: "Changed" },
      customFields: { weight: 4 },
    }, staff);
    expect(changed.ok).toBe(true);
    expect(
      (await kernel.services.catalog.setAttributes(created.value.id, "en", {
        title: "Changed title",
      }, staff)).ok,
    ).toBe(true);

    const beforeRestore = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    expect(beforeRestore).toHaveLength(3);

    const restored = await kernel.services.catalog.restoreEntityRevision(
      created.value.id,
      beforeRestore[0]!.id,
      staff,
    );
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw restored.error;

    const current = await kernel.services.catalog.getById(
      created.value.id,
      { includeAttributes: true },
      staff,
    );
    expect(current.ok).toBe(true);
    if (!current.ok) throw current.error;
    expect(current.value).toMatchObject({ metadata: { title: "Original" } });
    expect(current.value.attributes).toEqual([
      expect.objectContaining({ locale: "en", title: "Original title" }),
    ]);
    expect(await kernel.services.catalog.repository.findCustomFieldsByEntityId(created.value.id)).toEqual([
      expect.objectContaining({ fieldName: "weight", numberValue: 1 }),
    ]);

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    expect(revisions).toHaveLength(4);
    expect(revisions[3]).toMatchObject({
      revision: 4,
      reason: "restore",
      actorId: staff.userId,
    });
    expect(revisions[3]?.snapshot).toMatchObject({
      entity: expect.objectContaining({ metadata: { title: "Original" } }),
      attributes: [expect.objectContaining({ title: "Original title" })],
      customFields: [expect.objectContaining({ fieldName: "weight", numberValue: 1 })],
    });
  });

  it("trims old revisions while sparing pinned rows and revision one", async () => {
    const created = await kernel.services.catalog.create({
      type: "product",
      slug: "retention",
    }, staff);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    await kernel.services.catalog.update(created.value.id, {
      metadata: { version: 2 },
    }, staff);
    const initial = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    await kernel.services.catalog.repository.updateRevision(initial[1]!.id, {
      createdAt: old,
      pinned: true,
    });

    const spared = await kernel.services.catalog.trimEntityRevisions(staff, 90);
    expect(spared).toEqual({ ok: true, value: 0 });
    expect(await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id)).toHaveLength(2);

    await kernel.services.catalog.repository.updateRevision(initial[1]!.id, { pinned: false });
    const trimmed = await kernel.services.catalog.trimEntityRevisions(staff, 90);
    expect(trimmed).toEqual({ ok: true, value: 1 });
    const remaining = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ revision: 1, pinned: true });
  });

  it("rolls back the entity and revision together in the caller transaction", async () => {
    let rolledBackId: string | undefined;
    await expect(
      kernel.database.transaction(async (tx) => {
        const result = await kernel.services.catalog.create(
          { type: "product", slug: "rolled-back" },
          staff,
          createTxContext(tx, { actor: staff }),
        );
        expect(result.ok).toBe(true);
        if (result.ok) rolledBackId = result.value.id;
        throw new Error("rollback test");
      }),
    ).rejects.toThrow("rollback test");

    expect(await kernel.services.catalog.repository.findEntityBySlug("org_default", "rolled-back")).toBeUndefined();
    expect(rolledBackId).toBeDefined();
    if (!rolledBackId) throw new Error("rollback test did not create an entity id");
    expect(await kernel.services.catalog.repository.findRevisionsByEntityId(rolledBackId)).toEqual([]);
  });

  it("keeps revision numbers unique and monotonic across concurrent mutations", async () => {
    const created = await kernel.services.catalog.create({
      type: "product",
      slug: "concurrent-revisions",
      metadata: { version: 1 },
    }, staff);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const results = await Promise.all([
      kernel.services.catalog.update(created.value.id, { metadata: { version: 2 } }, staff),
      kernel.services.catalog.update(created.value.id, { metadata: { version: 3 } }, staff),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    const numbers = revisions.map((revision) => revision.revision);
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers.length).toBeGreaterThanOrEqual(2);
  });

  it("allows an outbound push path to record the sent state before sending", async () => {
    const created = await kernel.services.catalog.create({
      type: "product",
      slug: "push-revision",
      metadata: { title: "Push me" },
    }, staff);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const pushed = await kernel.services.catalog.recordEntityRevision(created.value.id, staff, "push");
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) throw pushed.error;
    expect(pushed.value).toMatchObject({ revision: 2, reason: "push" });
  });

  it("restore deletes rows added after the restored revision", async () => {
    const created = await kernel.services.catalog.create({
      type: "product",
      slug: "restore-prunes",
      customFields: { weight: 2 },
    }, staff);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    const first = revisions[0]!;

    const added = await kernel.services.catalog.update(created.value.id, {
      customFields: { brand: "acme" },
    }, staff);
    expect(added.ok).toBe(true);

    const restored = await kernel.services.catalog.restoreEntityRevision(created.value.id, first.id, staff);
    expect(restored.ok).toBe(true);

    const fields = await kernel.services.catalog.repository.findCustomFieldsByEntityId(created.value.id);
    expect(fields.map((field) => field.fieldName)).toEqual(["weight"]);
  });

  it("refuses to snapshot an entity from another organization", async () => {
    const created = await kernel.services.catalog.create({
      type: "product",
      slug: "cross-org-record",
    }, staff);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const outsider: Actor = {
      ...staff,
      userId: "sellable-revisions-outsider",
      organizationId: "org_other",
    };
    const result = await kernel.services.catalog.recordEntityRevision(created.value.id, outsider, "push");
    expect(result.ok).toBe(false);
  });

  it("writes a revision when only a nested metadata key named createdAt changes", async () => {
    const created = await kernel.services.catalog.create({
      type: "product",
      slug: "nested-timestamp-key",
      metadata: { createdAt: "2020" },
    }, staff);
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const updated = await kernel.services.catalog.update(created.value.id, {
      metadata: { createdAt: "2021" },
    }, staff);
    expect(updated.ok).toBe(true);

    const revisions = await kernel.services.catalog.repository.findRevisionsByEntityId(created.value.id);
    expect(revisions).toHaveLength(2);
  });
});
