import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const ORG_A = "org_sec09_a";
const ORG_B = "org_sec09_b";

const adminA: Actor = {
  type: "user",
  userId: "sec09-admin-a",
  email: "a@sec09.test",
  name: "Admin A",
  vendorId: null,
  organizationId: ORG_A,
  role: "admin",
  permissions: ["*:*"],
};

const adminB: Actor = {
  type: "user",
  userId: "sec09-admin-b",
  email: "b@sec09.test",
  name: "Admin B",
  vendorId: null,
  organizationId: ORG_B,
  role: "admin",
  permissions: ["*:*"],
};

describe("SEC-09 — catalog option/variant mutations enforce org ownership", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let entityIdInB: string;
  let optionTypeIdInB: string;

  beforeAll(async () => {
    kernel = await createTestKernel();
    const db = kernel.database.db as {
      insert: (t: unknown) => {
        values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> };
      };
    };

    await db.insert(organization).values([
      { id: ORG_A, name: "SEC-09 Tenant A", slug: "sec09-a", createdAt: new Date() },
      { id: ORG_B, name: "SEC-09 Tenant B", slug: "sec09-b", createdAt: new Date() },
    ]).onConflictDoNothing();

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "sec09-victim", metadata: {} },
      adminB,
    );
    if (!entity.ok) {
      throw new Error(`Failed to seed Org B entity: ${JSON.stringify(entity.error)}`);
    }
    entityIdInB = entity.value.id;

    const optionType = await kernel.services.catalog.createOptionType(
      { entityId: entityIdInB, name: "size", values: ["s", "m"] },
      adminB,
    );
    if (!optionType.ok) {
      throw new Error(`Failed to seed Org B option type: ${JSON.stringify(optionType.error)}`);
    }
    optionTypeIdInB = optionType.value.id;
  });

  it("rejects Org A actor creating option type on Org B entity", async () => {
    const result = await kernel.services.catalog.createOptionType(
      { entityId: entityIdInB, name: "color", values: ["red"] },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects Org A actor creating option value on Org B option type", async () => {
    const result = await kernel.services.catalog.createOptionValue(
      { optionTypeId: optionTypeIdInB, value: "l" },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects Org A actor creating variant on Org B entity", async () => {
    const result = await kernel.services.catalog.createVariant(
      { entityId: entityIdInB, options: { size: "s" } },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("rejects Org A actor generating variants on Org B entity", async () => {
    const result = await kernel.services.catalog.generateVariants(
      entityIdInB,
      { mode: "all" },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("still allows Org B actor to create option type on its own entity", async () => {
    const result = await kernel.services.catalog.createOptionType(
      { entityId: entityIdInB, name: "material", values: ["cotton"] },
      adminB,
    );
    expect(result.ok).toBe(true);
  });
});