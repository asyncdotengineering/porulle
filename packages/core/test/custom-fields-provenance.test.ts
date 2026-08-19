import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const staff: Actor = {
  type: "user",
  userId: "custom-fields-provenance-staff",
  email: "custom-fields-provenance-staff@example.com",
  name: "Custom Fields Provenance Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: ["catalog:create", "catalog:update", "catalog:read"],
};

describe("catalog custom field value provenance", () => {
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

  async function createEntity(withCustomField = true) {
    const result = await kernel.services.catalog.create(
      {
        type: "product",
        slug: "custom-fields-provenance-product",
        ...(withCustomField ? { customFields: { warranty: "1y" } } : {}),
      },
      staff,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    return result.value.id;
  }

  it("keeps existing custom-field creates merchant-approved by default", async () => {
    const entityId = await createEntity();

    const fields = await kernel.services.catalog.repository.findCustomFieldsByEntityId(entityId);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      fieldName: "warranty",
      textValue: "1y",
      source: "merchant",
      status: "approved",
      confidence: null,
      evidence: null,
      locale: "en",
      approvedAt: null,
      approvedBy: null,
    });
    expect(fields[0]?.createdAt).toBeInstanceOf(Date);
    expect(fields[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("allows a proposal beside one approved value but rejects a second approved value", async () => {
    const entityId = await createEntity(false);
    const repository = kernel.services.catalog.repository;

    const proposed = await repository.createCustomField({
      entityId,
      fieldName: "warranty",
      fieldType: "text",
      textValue: "18m",
      source: "enrichment",
      status: "proposed",
      confidence: "0.820",
      evidence: { model: "catalog-enrichment-v1" },
      locale: "en",
    });
    const approved = await repository.createCustomField({
      entityId,
      fieldName: "warranty",
      fieldType: "text",
      textValue: "1y",
      source: "merchant",
      status: "approved",
      locale: "en",
    });

    expect(proposed.status).toBe("proposed");
    expect(approved.status).toBe("approved");
    expect(await repository.findAllCustomFieldsByEntityId(entityId)).toHaveLength(2);
    expect(await repository.findCustomFieldsByEntityId(entityId)).toEqual([
      expect.objectContaining({ id: approved.id, status: "approved", textValue: "1y" }),
    ]);

    await expect(
      repository.createCustomField({
        entityId,
        fieldName: "warranty",
        fieldType: "text",
        textValue: "2y",
        source: "merchant",
        status: "approved",
        locale: "en",
      }),
    ).rejects.toThrow();
  });

  it("persists rejected values but excludes them from approved-only reads", async () => {
    const entityId = await createEntity(false);
    const repository = kernel.services.catalog.repository;

    const rejected = await repository.createCustomField({
      entityId,
      fieldName: "warranty",
      fieldType: "text",
      textValue: "9m",
      source: "enrichment",
      status: "rejected",
      locale: "en",
    });

    expect(rejected.status).toBe("rejected");
    expect(await repository.findCustomFieldsByEntityId(entityId)).toEqual([]);
    expect(await repository.findAllCustomFieldsByEntityId(entityId)).toEqual([
      expect.objectContaining({ id: rejected.id, status: "rejected", textValue: "9m" }),
    ]);
  });
});
