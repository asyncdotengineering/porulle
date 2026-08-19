import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const staff: Actor = {
  type: "user",
  userId: "custom-fields-select-staff",
  email: "custom-fields-select-staff@example.com",
  name: "Custom Fields Select Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: ["catalog:create", "catalog:update", "catalog:read"],
};

describe("catalog select custom field validation", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const built = await createPGliteTestConfig({
      entities: {
        product: {
          fields: [
            { name: "colour", type: "select", options: ["black", "white", "oat"] },
            { name: "fit", type: "select" },
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

  it("rejects a value outside the declared options and names the allowed set", async () => {
    const result = await kernel.services.catalog.create(
      { type: "product", slug: "select-invalid", customFields: { colour: "Blck" } },
      staff,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.error.message).toContain('"Blck"');
    expect(result.error.message).toContain("black, white, oat");
  });

  it("accepts a declared option and stores the field type as select", async () => {
    const result = await kernel.services.catalog.create(
      { type: "product", slug: "select-valid", customFields: { colour: "black" } },
      staff,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const fields = await kernel.services.catalog.repository.findCustomFieldsByEntityId(result.value.id);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.fieldType).toBe("select");
    expect(fields[0]?.textValue).toBe("black");
  });

  it("trims surrounding whitespace but changes nothing else", async () => {
    const trimmed = await kernel.services.catalog.create(
      { type: "product", slug: "select-trimmed", customFields: { colour: "  black  " } },
      staff,
    );
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) throw trimmed.error;
    const fields = await kernel.services.catalog.repository.findCustomFieldsByEntityId(trimmed.value.id);
    expect(fields[0]?.textValue).toBe("black");

    const cased = await kernel.services.catalog.create(
      { type: "product", slug: "select-cased", customFields: { colour: "BLACK" } },
      staff,
    );
    expect(cased.ok).toBe(false);
  });

  it("leaves a select field without options unconstrained", async () => {
    const result = await kernel.services.catalog.create(
      { type: "product", slug: "select-open", customFields: { fit: "anything goes" } },
      staff,
    );
    expect(result.ok).toBe(true);
  });

  it("enforces options on the update path as well", async () => {
    const created = await kernel.services.catalog.create(
      { type: "product", slug: "select-update", customFields: { colour: "black" } },
      staff,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw created.error;

    const rejected = await kernel.services.catalog.update(
      created.value.id,
      { customFields: { colour: "Blck" } },
      staff,
    );
    expect(rejected.ok).toBe(false);

    const accepted = await kernel.services.catalog.update(
      created.value.id,
      { customFields: { colour: "oat" } },
      staff,
    );
    expect(accepted.ok).toBe(true);
  });
});
