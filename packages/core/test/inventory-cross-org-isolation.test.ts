import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { ensureDefaultOrg } from "../src/auth/org.js";
import { organization } from "../src/auth/auth-schema.js";
import type { Actor } from "../src/auth/types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import type { Kernel } from "../src/runtime/kernel.js";

const ORG_A = "org_inv_cross_a";
const ORG_B = "org_inv_cross_b";

const actorA: Actor = {
  type: "user",
  userId: "inv-cross-a",
  email: "a@inv-cross.test",
  name: "Org A",
  vendorId: null,
  organizationId: ORG_A,
  role: "admin",
  permissions: ["*:*"],
};

const actorB: Actor = {
  type: "user",
  userId: "inv-cross-b",
  email: "b@inv-cross.test",
  name: "Org B",
  vendorId: null,
  organizationId: ORG_B,
  role: "admin",
  permissions: ["*:*"],
};

describe("inventory cross-org isolation (repository + service)", () => {
  let kernel: Kernel;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);

    const db = kernel.database.db as DrizzleDatabase;
    await ensureDefaultOrg(db);

    await db.insert(organization).values({
      id: ORG_A,
      name: "Cross A",
      slug: "inv-cross-a",
      createdAt: new Date(),
    });
    await db.insert(organization).values({
      id: ORG_B,
      name: "Cross B",
      slug: "inv-cross-b",
      createdAt: new Date(),
    });
  }, 30_000);

  afterAll(async () => {
    await cleanup();
  });

  it("actor B adjusting entity X does not see org A levels (separate B row)", async () => {
    const entity = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `inv-cross-entity-${Date.now()}`,
        attributes: { title: "Shared id probe" },
        metadata: {},
      },
      actorA,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse(
      { name: "Warehouse A", code: `WHA-${Date.now()}` },
      actorA,
    );

    const adjustA = await kernel.services.inventory.adjust(
      {
        entityId: entity.value.id,
        adjustment: 10,
        reason: "seed-org-a",
      },
      actorA,
    );
    expect(adjustA.ok).toBe(true);

    const adjustB = await kernel.services.inventory.adjust(
      {
        entityId: entity.value.id,
        adjustment: 5,
        reason: "seed-org-b",
      },
      actorB,
    );
    expect(adjustB.ok).toBe(true);

    const levelsA = await kernel.services.inventory.getLevelsByEntityId(
      entity.value.id,
      undefined,
      actorA,
    );
    const levelsB = await kernel.services.inventory.getLevelsByEntityId(
      entity.value.id,
      undefined,
      actorB,
    );
    expect(levelsA.ok).toBe(true);
    expect(levelsB.ok).toBe(true);
    if (!levelsA.ok || !levelsB.ok) return;

    const onHandA = levelsA.value.reduce((s, l) => s + l.quantityOnHand, 0);
    const onHandB = levelsB.value.reduce((s, l) => s + l.quantityOnHand, 0);
    expect(onHandA).toBe(10);
    expect(onHandB).toBe(5);

    for (const row of levelsA.value) {
      expect(row.organizationId).toBe(ORG_A);
    }
    for (const row of levelsB.value) {
      expect(row.organizationId).toBe(ORG_B);
    }
  });

  it("actor A listing levels for org B warehouse id returns no rows", async () => {
    const whB = await kernel.services.inventory.createWarehouse(
      { name: "Warehouse B only", code: `WHB-${Date.now()}` },
      actorB,
    );
    expect(whB.ok).toBe(true);
    if (!whB.ok) return;

    const list = await kernel.services.inventory.listLevels(
      { warehouseId: whB.value.id },
      actorA,
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value).toHaveLength(0);
  });
});
