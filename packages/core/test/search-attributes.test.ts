import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const staff: Actor = {
  type: "user",
  userId: "search-attributes-staff",
  email: "search-attributes-staff@example.com",
  name: "Search Attributes Staff",
  vendorId: null,
  organizationId: "org_default",
  role: "staff",
  permissions: ["catalog:create", "catalog:update", "catalog:read", "catalog:read:unpublished"],
};

describe("search custom attributes", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createPGliteTestConfig({
      entities: {
        product: {
          fields: [
            { name: "material", type: "select", filterable: true },
            { name: "occasion", type: "select", filterable: true },
            { name: "bookkeeping", type: "text" },
          ],
          variants: { enabled: false },
          fulfillment: "physical",
        },
      },
    });
    cleanup = built.cleanup;
    kernel = createKernel(built.config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function createProduct(
    slug: string,
    customFields: Record<string, string>,
  ): Promise<string> {
    const result = await kernel.services.catalog.create(
      { type: "product", slug, status: "active", customFields },
      staff,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  it("filters with AND across keys and OR within a key", async () => {
    const linenResort = await createProduct("linen-resort", {
      material: "linen",
      occasion: "resort",
    });
    await createProduct("linen-business", {
      material: "linen",
      occasion: "business",
    });
    await createProduct("cotton-wedding", {
      material: "cotton",
      occasion: "wedding",
    });
    const linenWedding = await createProduct("linen-wedding", {
      material: "linen",
      occasion: "wedding",
    });

    const result = await kernel.services.search.query({
      query: "",
      filters: {
        type: "product",
        attributes: {
          material: "linen",
          occasion: ["resort", "wedding"],
        },
      },
    }, { actor: staff, tx: null, requestId: "search-attributes-filter" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.hits.map((hit) => hit.id).sort()).toEqual(
      [linenResort, linenWedding].sort(),
    );
  });

  it("indexes only filterable approved values and facets count entities once", async () => {
    const linenResort = await createProduct("approved-linen-resort", {
      material: "linen",
      occasion: "resort",
      bookkeeping: "internal-only",
    });
    await createProduct("approved-linen-business", {
      material: "linen",
      occasion: "business",
    });
    await createProduct("approved-cotton-wedding", {
      material: "cotton",
      occasion: "wedding",
    });
    await createProduct("approved-cotton-resort", {
      material: "cotton",
      occasion: "resort",
    });
    await createProduct("approved-linen-wedding", {
      material: "linen",
      occasion: "wedding",
    });

    await kernel.services.catalog.repository.createCustomField({
      entityId: linenResort,
      fieldName: "material",
      fieldType: "select",
      textValue: "unapproved",
      source: "enrichment",
      status: "proposed",
      locale: "en",
    });

    const result = await kernel.services.search.query({
      query: "",
      filters: { type: "product" },
      facets: ["material", "occasion", "bookkeeping"],
    }, { actor: staff, tx: null, requestId: "search-attributes-facets" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.facets).toEqual({
      material: { linen: 3, cotton: 2 },
      occasion: { resort: 2, business: 1, wedding: 2 },
    });

    const indexed = result.value.hits.find((hit) => hit.id === linenResort);
    expect(indexed?.document.attributes).toEqual({
      material: "linen",
      occasion: "resort",
    });

    const nonFilterable = await kernel.services.search.query({
      query: "",
      filters: { type: "product", attributes: { bookkeeping: "internal-only" } },
    }, { actor: staff, tx: null, requestId: "search-attributes-nonfilterable" });
    expect(nonFilterable.ok).toBe(true);
    if (!nonFilterable.ok) throw nonFilterable.error;
    expect(nonFilterable.value.total).toBe(0);
  });
});
