import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

const ORG_DEFAULT = "org_default";
const ORG_OTHER = "org_sec11_other";

const adminOther: Actor = {
  type: "user",
  userId: "sec11-admin-other",
  email: "other@sec11.test",
  name: "Other Org Admin",
  vendorId: null,
  organizationId: ORG_OTHER,
  role: "admin",
  permissions: ["*:*"],
};

describe("SEC-11 — anonymous catalog getById enforces org context", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let entityIdInOther: string;

  beforeAll(async () => {
    kernel = await createTestKernel();
    const db = kernel.database.db as {
      insert: (t: unknown) => {
        values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> };
      };
    };

    await db.insert(organization).values([
      { id: ORG_OTHER, name: "SEC-11 Other Tenant", slug: "sec11-other", createdAt: new Date() },
    ]).onConflictDoNothing();

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "sec11-private-product", metadata: { secret: true } },
      adminOther,
    );
    if (!entity.ok) {
      throw new Error(`Failed to seed other-org entity: ${JSON.stringify(entity.error)}`);
    }
    entityIdInOther = entity.value.id;
    expect(entity.value.organizationId).toBe(ORG_OTHER);
  });

  it("rejects anonymous read of another org's entity by id", async () => {
    const result = await kernel.services.catalog.getById(entityIdInOther, undefined, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("still allows owning org admin to read the entity", async () => {
    const result = await kernel.services.catalog.getById(entityIdInOther, undefined, adminOther);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.organizationId).toBe(ORG_OTHER);
      expect(result.value.slug).toBe("sec11-private-product");
    }
  });

  it("allows anonymous read within default org context only", async () => {
    const localEntity = await kernel.services.catalog.create(
      { type: "product", slug: "sec11-default-product", metadata: {} },
      {
        type: "user",
        userId: "sec11-default-admin",
        email: "default@sec11.test",
        name: "Default Admin",
        vendorId: null,
        organizationId: ORG_DEFAULT,
        role: "admin",
        permissions: ["*:*"],
      },
    );
    expect(localEntity.ok).toBe(true);
    if (!localEntity.ok) return;

    const result = await kernel.services.catalog.getById(localEntity.value.id, undefined, null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.organizationId).toBe(ORG_DEFAULT);
    }
  });
});