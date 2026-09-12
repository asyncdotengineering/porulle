import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const ORG = "org_list_source_store_filter";
const STORE_A = "00000000-0000-4000-8000-00000000f0a1";
const STORE_B = "00000000-0000-4000-8000-00000000f0b1";

const admin: Actor = {
  type: "user",
  userId: "list-source-store-admin",
  email: "list-source-store@test.local",
  name: "List By Store",
  vendorId: null,
  organizationId: ORG,
  role: "admin",
  permissions: ["*:*"],
};

describe("catalog list filtered by source store", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  const ids: Record<string, string> = {};

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
      { id: ORG, name: "List By Store", slug: "list-by-store", createdAt: new Date() },
    ]).onConflictDoNothing();
    for (const [key, sourceStoreId] of [["a", STORE_A], ["b", STORE_B], ["none", undefined]] as const) {
      const created = await kernel.services.catalog.create(
        { type: "product", slug: `list-by-store-${key}`, metadata: {}, ...(sourceStoreId ? { sourceStoreId } : {}) },
        admin,
      );
      if (!created.ok) throw created.error;
      ids[key] = created.value.id;
    }
  });

  async function listIds(sourceStoreIds?: string[]) {
    const result = await kernel.services.catalog.list(
      { filter: { type: "product", ...(sourceStoreIds ? { sourceStoreIds } : {}) }, pagination: { page: 1, limit: 50 } },
      admin,
    );
    if (!result.ok) throw result.error;
    return { ids: result.value.items.map((item) => item.id), total: result.value.pagination.total };
  }

  it("returns only the entities imported by the named stores, with a matching total", async () => {
    const onlyA = await listIds([STORE_A]);
    expect(onlyA.ids).toEqual([ids.a]);
    expect(onlyA.total).toBe(1);

    const both = await listIds([STORE_A, STORE_B]);
    expect(new Set(both.ids)).toEqual(new Set([ids.a, ids.b]));
    expect(both.total).toBe(2);
  });

  it("matches nothing for an empty store list rather than widening to the organization", async () => {
    const none = await listIds([]);
    expect(none.ids).toEqual([]);
    expect(none.total).toBe(0);
  });

  it("leaves an unfiltered list untouched", async () => {
    const all = await listIds();
    expect(new Set(all.ids)).toEqual(new Set([ids.a, ids.b, ids.none]));
  });
});
