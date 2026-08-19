import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const staff: Actor = {
  type: "user",
  userId: "custom-fields-staff",
  email: "custom-fields-staff@example.com",
  name: "Custom Fields Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: ["catalog:create", "catalog:update", "catalog:read"],
};

describe("catalog custom field updates", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createPGliteTestConfig({
      entities: {
        product: {
          fields: [{ name: "warranty", type: "text" }],
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

  async function createEntity() {
    const result = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "custom-fields-product",
        customFields: { warranty: "1y" },
      },
      staff,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  async function findWarranty(entityId: string) {
    const fields = await kernel.services.catalog.repository.findCustomFieldsByEntityId(entityId);
    return fields.filter((field) => field.fieldName === "warranty");
  }

  it("updates a custom field without creating a duplicate row", async () => {
    const entityId = await createEntity();

    const updated = await kernel.services.catalog.update(
      entityId,
      { customFields: { warranty: "2y" } },
      staff,
    );

    if (!updated.ok) throw updated.error;
    const warranty = await findWarranty(entityId);
    expect(warranty).toHaveLength(1);
    expect(warranty[0]?.textValue).toBe("2y");
  });

  it("clears a custom field when its update value is null", async () => {
    const entityId = await createEntity();

    const updated = await kernel.services.catalog.update(
      entityId,
      { customFields: { warranty: null } },
      staff,
    );

    if (!updated.ok) throw updated.error;
    expect(await findWarranty(entityId)).toHaveLength(0);
  });

  it("leaves a custom field unchanged when it is omitted from the update", async () => {
    const entityId = await createEntity();

    const changed = await kernel.services.catalog.update(
      entityId,
      { customFields: { warranty: "2y" } },
      staff,
    );
    if (!changed.ok) throw changed.error;

    const unchanged = await kernel.services.catalog.update(
      entityId,
      { customFields: {} },
      staff,
    );

    if (!unchanged.ok) throw unchanged.error;
    const warranty = await findWarranty(entityId);
    expect(warranty).toHaveLength(1);
    expect(warranty[0]?.textValue).toBe("2y");
  });
});
