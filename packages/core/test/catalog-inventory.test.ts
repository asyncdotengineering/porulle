import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const staff = {
  type: "user",
  userId: "staff-1",
  email: "staff@example.com",
  name: "Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:delete",
    "catalog:read",
    "inventory:adjust",
    "cart:create",
    "cart:update",
    "orders:create",
    "orders:read",
    "orders:update",
    "customers:update:self",
  ],
} as any;

describe("catalog + inventory (PGlite-backed)", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    // Truncate all tables between tests for isolation
    await cleanup();
  });

  it("supports entity lifecycle, localization, variants and inventory adjustments", async () => {
    const created = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "blue-widget",
        attributes: {
          locale: "en",
          title: "Blue Widget",
          description: "Test entity",
        },
        customFields: {
          weight: 100,
          brand: "ACME",
        },
      },
      staff,
    );

    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const published = await kernel.services.catalog.publish(created.value.id, staff);
    expect(published.ok).toBe(true);

    const category = await kernel.services.catalog.createCategory(
      { slug: "apparel", sortOrder: 1 },
      staff,
    );
    const brand = await kernel.services.catalog.createBrand(
      { slug: "acme", displayName: "ACME" },
      staff,
    );
    expect(category.ok && brand.ok).toBe(true);
    if (!category.ok || !brand.ok) return;

    const linkedCategory = await kernel.services.catalog.addToCategory(created.value.id, category.value.id, staff);
    const linkedBrand = await kernel.services.catalog.addToBrand(created.value.id, brand.value.id, staff);
    expect(linkedCategory.ok && linkedBrand.ok).toBe(true);

    const filteredByBrand = await kernel.services.catalog.list({
      filter: { brand: "acme" },
      pagination: { page: 1, limit: 10 },
    });
    expect(filteredByBrand.ok).toBe(true);
    if (filteredByBrand.ok) {
      expect(filteredByBrand.value.items.some((item) => item.id === created.value.id)).toBe(true);
    }

    const optionType = await kernel.services.catalog.createOptionType(
      {
        entityId: created.value.id,
        name: "size",
      },
      staff,
    );
    expect(optionType.ok).toBe(true);
    if (!optionType.ok) return;

    const small = await kernel.services.catalog.createOptionValue(
      {
        optionTypeId: optionType.value.id,
        value: "S",
      },
      staff,
    );
    const large = await kernel.services.catalog.createOptionValue(
      {
        optionTypeId: optionType.value.id,
        value: "L",
      },
      staff,
    );

    expect(small.ok && large.ok).toBe(true);

    const generated = await kernel.services.catalog.generateVariants(
      created.value.id,
      {
        mode: "all",
      },
      staff,
    );
    expect(generated.ok).toBe(true);

    const setAttr = await kernel.services.catalog.setAttributes(created.value.id, "fr", {
      title: "Widget Bleu",
      description: "Description FR",
    }, staff);
    expect(setAttr.ok).toBe(true);

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });

    const adjusted = await kernel.services.inventory.adjust(
      {
        entityId: created.value.id,
        adjustment: 50,
        reason: "initial stock",
      },
      staff,
    );

    expect(adjusted.ok).toBe(true);

    const available = await kernel.services.inventory.getAvailable(created.value.id);
    expect(available.ok && available.value).toBe(50);
  });
});
