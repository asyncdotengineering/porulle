import { beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "../src/auth/types.js";
import { organization } from "../src/auth/auth-schema.js";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";
import { PricingRepository } from "../src/modules/pricing/repository/index.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

const ORG_A = "org_pricing_a";
const ORG_B = "org_pricing_b";

const adminA: Actor = {
  type: "user",
  userId: "pricing-admin-a",
  email: "a@pricing.test",
  name: "Pricing Admin A",
  vendorId: null,
  organizationId: ORG_A,
  role: "admin",
  permissions: ["*:*"],
};

const adminB: Actor = {
  type: "user",
  userId: "pricing-admin-b",
  email: "b@pricing.test",
  name: "Pricing Admin B",
  vendorId: null,
  organizationId: ORG_B,
  role: "admin",
  permissions: ["*:*"],
};

describe("pricing cross-tenant isolation", () => {
  let kernel: Awaited<ReturnType<typeof createTestKernel>>;
  let entityAId: string;
  let entityBId: string;

  beforeAll(async () => {
    kernel = await createTestKernel();
    const db = kernel.database.db as {
      insert: (t: unknown) => {
        values: (v: unknown) => { onConflictDoNothing: () => Promise<unknown> };
      };
    };
    await db.insert(organization).values([
      { id: ORG_A, name: "Pricing Tenant A", slug: "pricing-a", createdAt: new Date() },
      { id: ORG_B, name: "Pricing Tenant B", slug: "pricing-b", createdAt: new Date() },
    ]).onConflictDoNothing();

    const createdA = await kernel.services.catalog.create(
      { type: "product", slug: "pricing-entity-a", metadata: {} },
      adminA,
    );
    const createdB = await kernel.services.catalog.create(
      { type: "product", slug: "pricing-entity-b", metadata: {} },
      adminB,
    );
    expect(createdA.ok).toBe(true);
    expect(createdB.ok).toBe(true);
    if (!createdA.ok || !createdB.ok) {
      throw new Error("Failed to create seed entities.");
    }
    entityAId = createdA.value.id;
    entityBId = createdB.value.id;

    const baseA = await kernel.services.pricing.setBasePrice(
      { entityId: entityAId, currency: "USD", amount: 1000 },
      adminA,
    );
    const baseB = await kernel.services.pricing.setBasePrice(
      { entityId: entityBId, currency: "USD", amount: 2000 },
      adminB,
    );
    expect(baseA.ok).toBe(true);
    expect(baseB.ok).toBe(true);

  });

  it("org-wide modifier applies only within the actor org", async () => {
    const created = await kernel.services.pricing.createModifier(
      {
        name: "org-b-global-discount",
        type: "fixed_discount",
        value: 300,
      },
      adminB,
    );
    expect(created.ok).toBe(true);

    const quoteB = await kernel.services.pricing.resolve(
      { entityId: entityBId, currency: "USD", quantity: 1 },
      adminB,
    );
    const quoteA = await kernel.services.pricing.resolve(
      { entityId: entityAId, currency: "USD", quantity: 1 },
      adminA,
    );
    expect(quoteB.ok).toBe(true);
    expect(quoteA.ok).toBe(true);
    if (quoteB.ok && quoteA.ok) {
      expect(quoteB.value.finalAmount).toBe(1700);
      expect(quoteA.value.finalAmount).toBe(1000);
    }
  });

  it("findActiveModifiers is org-scoped", async () => {
    const repo = new PricingRepository(kernel.database.db as DrizzleDatabase);
    const forA = await repo.findActiveModifiers(ORG_A, entityAId);
    const forB = await repo.findActiveModifiers(ORG_B, entityAId);
    expect(forA.length).toBe(0);
    expect(forB.some((m) => m.name === "org-b-global-discount")).toBe(true);
  });

  it("findPricesByEntityId is org-scoped for cross-tenant entity id probes", async () => {
    const repo = new PricingRepository(kernel.database.db as DrizzleDatabase);
    const crossRead = await repo.findPricesByEntityId(ORG_A, entityBId);
    expect(crossRead).toHaveLength(0);
  });
});
