import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { organization } from "../src/auth/auth-schema.js";
import type { Actor } from "../src/auth/types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { catalogFieldOwnership } from "../src/modules/catalog/schema.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import {
  createTestServer,
  makeRequest,
  parseJsonResponse,
  testActor,
} from "../src/test-utils/rest-api-test-utils.js";

const ORG_A = "org_field_ownership_a";
const ORG_B = "org_field_ownership_b";
const STORE_A = "store-field-ownership-a";

function actor(organizationId: string): Actor {
  return {
    type: "user",
    userId: `field-ownership-${organizationId}`,
    email: `${organizationId}@test.local`,
    name: organizationId,
    vendorId: null,
    organizationId,
    role: "admin",
    permissions: ["*:*"],
  };
}

describe("catalog field ownership", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;
  const adminA = actor(ORG_A);
  const adminB = actor(ORG_B);

  beforeAll(async () => {
    const built = await createPGliteTestConfig();
    cleanup = built.cleanup;
    kernel = createKernel(built.config);
    const db = kernel.database.db as DrizzleDatabase;
    await db.insert(organization).values([
      { id: ORG_A, name: "Field Ownership A", slug: "field-ownership-a", createdAt: new Date() },
      { id: ORG_B, name: "Field Ownership B", slug: "field-ownership-b", createdAt: new Date() },
    ]).onConflictDoNothing();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    const db = kernel.database.db as DrizzleDatabase;
    await db.insert(organization).values([
      { id: ORG_A, name: "Field Ownership A", slug: "field-ownership-a", createdAt: new Date() },
      { id: ORG_B, name: "Field Ownership B", slug: "field-ownership-b", createdAt: new Date() },
    ]).onConflictDoNothing();
  });

  async function createEntity(owner: Actor = adminA): Promise<string> {
    const result = await kernel.services.catalog.create({
      type: "product",
      slug: `field-ownership-${crypto.randomUUID()}`,
      metadata: { color: "blue" },
      attributes: { title: "Imported product" },
      sourceStoreId: STORE_A,
    }, owner);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  it("rejects invalid and wildcard field paths", async () => {
    const entityId = await createEntity();
    for (const fieldPath of [
      "*",
      "metadata.*",
      "attributes..title",
      ".slug",
      "slug.",
      "attributes.en.title/extra",
      "attributes.en.title with spaces",
    ]) {
      const result = await kernel.services.catalog.setFieldOwner(
        entityId,
        fieldPath,
        STORE_A,
        "store",
        adminA,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("seeds imported fields idempotently and leaves unowned fields undefined", async () => {
    const entityId = await createEntity();
    const importedFields = ["entity.slug", "entity.metadata.color", "attributes.en.title"];

    const first = await kernel.services.catalog.seedImportedFieldOwnership(
      entityId,
      STORE_A,
      importedFields,
    );
    const second = await kernel.services.catalog.seedImportedFieldOwnership(
      entityId,
      STORE_A,
      importedFields,
    );

    expect(first).toEqual({ ok: true, value: undefined });
    expect(second).toEqual({ ok: true, value: undefined });
    const rows = await kernel.services.catalog.listFieldOwnership(entityId, adminA);
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.value).toHaveLength(importedFields.length);

    const resolved = await kernel.services.catalog.resolveFieldOwners(entityId, STORE_A);
    expect(resolved.get("entity.slug")).toBe("store");
    expect(resolved.get("entity.metadata.color")).toBe("store");
    expect(resolved.get("attributes.en.title")).toBe("store");
    expect(await kernel.services.catalog.resolveFieldOwner(entityId, "attributes.en.description", STORE_A)).toBeUndefined();
  });

  it("flips an owner explicitly and resolves store-specific rows before all-store rows", async () => {
    const entityId = await createEntity();
    await kernel.services.catalog.setFieldOwner(entityId, "entity.slug", null, "platform", adminA);
    await kernel.services.catalog.setFieldOwner(entityId, "entity.slug", STORE_A, "store", adminA);

    expect(await kernel.services.catalog.resolveFieldOwner(entityId, "entity.slug", STORE_A)).toBe("store");
    expect(await kernel.services.catalog.resolveFieldOwner(entityId, "entity.slug", "another-store")).toBe("platform");

    const changed = await kernel.services.catalog.setFieldOwner(
      entityId,
      "entity.slug",
      STORE_A,
      "shared",
      adminA,
    );
    expect(changed).toEqual({ ok: true, value: undefined });
    expect(await kernel.services.catalog.resolveFieldOwner(entityId, "entity.slug", STORE_A)).toBe("shared");
  });

  it("resolves variant-scoped rows above entity-level rows and excludes them from bulk resolution", async () => {
    const entityId = await createEntity();
    const variant = await kernel.services.catalog.createVariant({ entityId, options: {} }, adminA);
    expect(variant.ok).toBe(true);
    if (!variant.ok) throw variant.error;

    await kernel.services.catalog.setFieldOwner(entityId, "variants.sku", STORE_A, "store", adminA);
    await kernel.services.catalog.setFieldOwner(entityId, "variants.sku", null, "platform", adminA, undefined, variant.value.id);

    expect(
      await kernel.services.catalog.resolveFieldOwner(entityId, "variants.sku", STORE_A, undefined, variant.value.id),
    ).toBe("platform");
    expect(await kernel.services.catalog.resolveFieldOwner(entityId, "variants.sku", STORE_A)).toBe("store");

    const bulk = await kernel.services.catalog.resolveFieldOwners(entityId, STORE_A);
    expect(bulk.get("variants.sku")).toBe("store");
  });

  it("returns not found for cross-organization ownership access", async () => {
    const entityId = await createEntity();

    const listed = await kernel.services.catalog.listFieldOwnership(entityId, adminB);
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.error.code).toBe("NOT_FOUND");

    const changed = await kernel.services.catalog.setFieldOwner(
      entityId,
      "entity.slug",
      STORE_A,
      "platform",
      adminB,
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("NOT_FOUND");
  });

  it("rejects a duplicate ownership key at the database constraint", async () => {
    const entityId = await createEntity();
    const db = kernel.database.db as DrizzleDatabase;
    const row = {
      organizationId: ORG_A,
      entityId,
      variantId: null,
      storeId: STORE_A,
      fieldPath: "entity.slug",
      owner: "platform" as const,
    };
    await db.insert(catalogFieldOwnership).values(row);
    await expect(db.insert(catalogFieldOwnership).values(row)).rejects.toThrow();
  });
});

describe("catalog field ownership REST", () => {
  let server: Awaited<ReturnType<typeof createTestServer>>["server"];
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createTestServer();
    server = built.server;
    cleanup = built.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  it("reads and changes ownership for a product", async () => {
    const created = await makeRequest(server, {
      method: "POST",
      url: "http://localhost/api/catalog/entities",
      body: { type: "product", slug: `ownership-rest-${crypto.randomUUID()}`, metadata: {} },
      actor: testActor,
    });
    const entity = await parseJsonResponse<{ data: { id: string } }>(created);

    const changed = await makeRequest(server, {
      method: "PUT",
      url: `http://localhost/api/catalog/entities/${entity.data.id}/field-ownership`,
      body: { fieldPath: "entity.slug", storeId: STORE_A, owner: "store" },
      actor: testActor,
    });
    expect(changed.status).toBe(200);

    const listed = await makeRequest(server, {
      method: "GET",
      url: `http://localhost/api/catalog/entities/${entity.data.id}/field-ownership`,
      actor: testActor,
    });
    expect(listed.status).toBe(200);
    const body = await parseJsonResponse<{ data: Array<{ fieldPath: string; owner: string; storeId: string }> }>(listed);
    expect(body.data).toEqual([
      expect.objectContaining({ fieldPath: "entity.slug", owner: "store", storeId: STORE_A }),
    ]);
  });
});
