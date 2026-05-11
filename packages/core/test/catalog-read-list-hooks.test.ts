import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import type { AfterHook, BeforeHook } from "../src/kernel/hooks/types.js";
import type { ListParams } from "../src/modules/catalog/service.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

describe("catalog entity-scoped list hooks (kernel registry keys)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  const beforeListCalls: ListParams[] = [];
  const afterListResults: Array<{ total: number; ids: string[] }> = [];

  const actor: Actor = {
    type: "user",
    userId: "catalog-list-hooks-1",
    email: "clh@test.local",
    name: "List Hooks",
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "admin",
    permissions: ["*:*"],
  };

  beforeAll(async () => {
    const beforeList: BeforeHook<unknown>[] = [
      async ({ data }) => {
        beforeListCalls.push({ ...(data as ListParams) });
        return data;
      },
    ];
    const afterList: AfterHook<unknown>[] = [
      async ({ result }) => {
        const r = result as {
          items: Array<{ id: string }>;
          pagination: { total: number };
        };
        afterListResults.push({
          total: r.pagination.total,
          ids: r.items.map((i) => i.id),
        });
      },
    ];

    const { config, cleanup: c } = await createPGliteTestConfig({
      entities: {
        product: {
          fields: [{ name: "title", type: "text" }],
          variants: { enabled: false, optionTypes: [] },
          fulfillment: "physical",
          hooks: {
            beforeList,
            afterList,
          },
        },
      },
    });
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    beforeListCalls.length = 0;
    afterListResults.length = 0;
  });

  it("fires catalog.product.beforeList and catalog.product.afterList with expected payloads", async () => {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `list-hook-ent-${Date.now()}`,
        attributes: { locale: "en", title: "List Hook Product" },
      },
      actor,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const listParams: ListParams = {
      filter: { type: "product" },
      pagination: { page: 1, limit: 10 },
    };
    const listed = await kernel.services.catalog.list(listParams, actor);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    expect(beforeListCalls).toEqual([
      {
        filter: { type: "product" },
        pagination: { page: 1, limit: 10 },
      },
    ]);

    expect(afterListResults).toHaveLength(1);
    expect(afterListResults[0]?.total).toBeGreaterThanOrEqual(1);
    expect(afterListResults[0]?.ids).toContain(created.value.id);
  });
});
