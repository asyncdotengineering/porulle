import { describe, it, expect, beforeAll } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";
import { organization } from "../src/auth/auth-schema.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const ORG_A = "org_tenant_a";
const ORG_B = "org_tenant_b";

const adminA: Actor = {
  type: "user",
  userId: "admin-a",
  email: "a@test.local",
  name: "Admin A",
  vendorId: null,
  organizationId: ORG_A,
  role: "admin",
  permissions: ["*:*"],
};

const adminB: Actor = {
  type: "user",
  userId: "admin-b",
  email: "b@test.local",
  name: "Admin B",
  vendorId: null,
  organizationId: ORG_B,
  role: "admin",
  permissions: ["*:*"],
};

describe("catalog — cross-tenant mutate is blocked (regression for CRITICAL-2)", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let entityIdInB: string;
  let categoryIdInB: string;
  let brandIdInB: string;

  beforeAll(async () => {
    kernel = await createTestKernel();
    const db = kernel.database.db as { insert: (t: unknown) => { values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> } } };

    // Seed both orgs so multi-tenant FKs are satisfied
    await db.insert(organization).values([
      { id: ORG_A, name: "Tenant A", slug: "a", createdAt: new Date() },
      { id: ORG_B, name: "Tenant B", slug: "b", createdAt: new Date() },
    ]).onConflictDoNothing();

    // Admin B creates a product, category, brand in Org B
    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "victim-product", attributes: { title: "Victim" }, metadata: {} },
      adminB,
    );
    if (!entity.ok) throw new Error(`Failed to seed Org B entity: ${JSON.stringify(entity.error)}`);
    entityIdInB = entity.value.id;

    const cat = await kernel.services.catalog.createCategory(
      { slug: "victim-cat" },
      adminB,
    );
    if (!cat.ok) throw new Error(`Failed to seed Org B category: ${JSON.stringify(cat.error)}`);
    categoryIdInB = cat.value.id;

    const brand = await kernel.services.catalog.createBrand(
      { slug: "victim-brand", displayName: "Victim Brand" },
      adminB,
    );
    if (!brand.ok) throw new Error(`Failed to seed Org B brand: ${JSON.stringify(brand.error)}`);
    brandIdInB = brand.value.id;
  });

  it("admin in Org A cannot update Org B's entity (NOT_FOUND, not FORBIDDEN, to avoid info disclosure)", async () => {
    const result = await kernel.services.catalog.update(
      entityIdInB,
      { slug: "hijacked", metadata: { hijacked: true } },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot delete Org B's entity", async () => {
    const result = await kernel.services.catalog.delete(entityIdInB, adminA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot publish Org B's entity", async () => {
    const result = await kernel.services.catalog.publish(entityIdInB, adminA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot setAttributes on Org B's entity", async () => {
    const result = await kernel.services.catalog.setAttributes(
      entityIdInB,
      "en",
      { title: "Hijacked" },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot updateCategory on Org B's category", async () => {
    const result = await kernel.services.catalog.updateCategory(
      categoryIdInB,
      { slug: "hijacked" },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot deleteCategory on Org B's category", async () => {
    const result = await kernel.services.catalog.deleteCategory(categoryIdInB, adminA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot updateBrand on Org B's brand", async () => {
    const result = await kernel.services.catalog.updateBrand(
      brandIdInB,
      { displayName: "Hijacked" },
      adminA,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot deleteBrand on Org B's brand", async () => {
    const result = await kernel.services.catalog.deleteBrand(brandIdInB, adminA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot addToCategory using Org B's entity", async () => {
    const result = await kernel.services.catalog.addToCategory(entityIdInB, "any-cat", adminA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("admin in Org A cannot addToBrand using Org B's entity", async () => {
    const result = await kernel.services.catalog.addToBrand(entityIdInB, "any-brand", adminA);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("Org B's entity is unchanged after all hijack attempts", async () => {
    const fetched = await kernel.services.catalog.getById(entityIdInB, undefined, adminB);
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.slug).toBe("victim-product");
      expect(fetched.value.organizationId).toBe(ORG_B);
    }
  });
});
