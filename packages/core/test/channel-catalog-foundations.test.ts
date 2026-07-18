import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import { createSystemActor } from "../src/auth/system-actor.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const ORG_A = "org_channel_foundations_a";
const ORG_B = "org_channel_foundations_b";
const STORE_A = "00000000-0000-4000-8000-0000000000a1";
const STORE_B = "00000000-0000-4000-8000-0000000000b1";

function actor(organizationId: string, permissions: string[]): Actor {
  return {
    type: "user",
    userId: `channel-${organizationId}`,
    email: `${organizationId}@channel.test`,
    name: organizationId,
    vendorId: null,
    organizationId,
    role: "staff",
    permissions,
  };
}

describe("channel catalog foundations", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  const adminA = actor(ORG_A, ["*:*"]);
  const adminB = actor(ORG_B, ["*:*"]);
  const staffA = actor(ORG_A, ["catalog:read", "catalog:update", "catalog:delete"]);

  beforeAll(async () => {
    kernel = await createTestKernel();
    const db = kernel.database.db as {
      insert: (table: typeof organization) => {
        values: (rows: Array<typeof organization.$inferInsert>) => {
          onConflictDoNothing: () => Promise<unknown>;
        };
      };
    };
    await db.insert(organization).values([
      { id: ORG_A, name: "Channel Foundations A", slug: "channel-foundations-a", createdAt: new Date() },
      { id: ORG_B, name: "Channel Foundations B", slug: "channel-foundations-b", createdAt: new Date() },
    ]).onConflictDoNothing();
  });

  async function createEntity(
    slug: string,
    owner: Actor,
    sourceStoreId?: string,
  ) {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug,
        metadata: {},
        ...(sourceStoreId !== undefined ? { sourceStoreId } : {}),
      },
      owner,
    );
    if (!created.ok) throw created.error;
    return created.value;
  }

  async function createVariant(entityId: string, sku: string | undefined, owner: Actor) {
    return kernel.services.catalog.createVariant(
      { entityId, options: {}, ...(sku !== undefined ? { sku } : {}) },
      owner,
    );
  }

  it("isolates channel-owned entities across organizations", async () => {
    const entity = await createEntity("channel-isolation", adminB, STORE_B);
    const result = await kernel.services.catalog.update(
      entity.id,
      { metadata: { compromised: true } },
      adminA,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("denies staff edits and allows the organization-scoped system actor", async () => {
    const entity = await createEntity("channel-write-guard", adminA, STORE_A);

    const denied = await kernel.services.catalog.update(
      entity.id,
      { metadata: { title: "Staff edit" } },
      staffA,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");

    const deniedPublish = await kernel.services.catalog.publish(entity.id, staffA);
    expect(deniedPublish.ok).toBe(false);
    if (!deniedPublish.ok) expect(deniedPublish.error.code).toBe("FORBIDDEN");

    const deniedDelete = await kernel.services.catalog.delete(entity.id, staffA);
    expect(deniedDelete.ok).toBe(false);
    if (!deniedDelete.ok) expect(deniedDelete.error.code).toBe("FORBIDDEN");

    const allowed = await kernel.services.catalog.update(
      entity.id,
      { metadata: { title: "Synchronized" } },
      createSystemActor(ORG_A),
    );
    expect(allowed.ok).toBe(true);
  });

  it("requires catalog:sync when assigning external provenance", async () => {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "channel-provenance-spoof",
        metadata: {},
        sourceStoreId: STORE_A,
      },
      { ...staffA, permissions: [...staffA.permissions, "catalog:create"] },
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe("FORBIDDEN");
  });

  it("allows the same SKU in two connected stores", async () => {
    const first = await createEntity("channel-sku-store-a", adminA, STORE_A);
    const second = await createEntity("channel-sku-store-b", adminA, STORE_B);

    expect((await createVariant(first.id, "SHARED-SKU", adminA)).ok).toBe(true);
    expect((await createVariant(second.id, "SHARED-SKU", adminA)).ok).toBe(true);
  });

  it("rejects duplicate SKUs within one connected store", async () => {
    const first = await createEntity("channel-sku-duplicate-a", adminA, STORE_A);
    const second = await createEntity("channel-sku-duplicate-b", adminA, STORE_A);

    expect((await createVariant(first.id, "STORE-DUP", adminA)).ok).toBe(true);
    await expect(createVariant(second.id, "STORE-DUP", adminA)).rejects.toThrow();
  });

  it("rejects duplicate native SKUs within an organization", async () => {
    const first = await createEntity("native-sku-a", adminA);
    const second = await createEntity("native-sku-b", adminA);

    expect((await createVariant(first.id, "NATIVE-DUP", adminA)).ok).toBe(true);
    await expect(createVariant(second.id, "NATIVE-DUP", adminA)).rejects.toThrow();
  });

  it("allows the same native SKU in different organizations", async () => {
    const first = await createEntity("native-cross-org-a", adminA);
    const second = await createEntity("native-cross-org-b", adminB);

    expect((await createVariant(first.id, "CROSS-ORG-SKU", adminA)).ok).toBe(true);
    expect((await createVariant(second.id, "CROSS-ORG-SKU", adminB)).ok).toBe(true);
  });

  it("allows multiple null SKUs in the same ownership scope", async () => {
    const first = await createEntity("null-sku-a", adminA, STORE_A);
    const second = await createEntity("null-sku-b", adminA, STORE_A);

    expect((await createVariant(first.id, undefined, adminA)).ok).toBe(true);
    expect((await createVariant(second.id, undefined, adminA)).ok).toBe(true);
  });
});
