import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";
import { testAdminActor } from "../src/test-utils/test-actors.js";

const N = 50;
const STARTING_QTY = 100;

describe("inventory concurrency – parallel adjust race", () => {
  let kernel: ReturnType<typeof createKernel>;
  let cleanup: () => Promise<void>;
  let entityId: string;
  let warehouseId: string;

  beforeAll(async () => {
    const { config, cleanup: c } = await createPGliteTestConfig();
    cleanup = c;
    kernel = createKernel(config);

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "concurrency-test", attributes: { title: "Race Test" }, metadata: {} },
      testAdminActor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) throw new Error("setup: failed to create entity");
    entityId = entity.value.id;

    const wh = await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    expect(wh.ok).toBe(true);
    if (!wh.ok) throw new Error("setup: failed to create warehouse");
    warehouseId = wh.value.id;

    const init = await kernel.services.inventory.adjust(
      { entityId, warehouseId, adjustment: STARTING_QTY, reason: "initial" },
      testAdminActor,
    );
    expect(init.ok).toBe(true);
  });

  afterAll(async () => {
    await cleanup();
  });

  it(`fires ${N} parallel adjust(+1) — final quantityOnHand === ${STARTING_QTY} + ${N}`, async () => {
    const adjusts = Array.from({ length: N }, () =>
      kernel.services.inventory.adjust(
        { entityId, warehouseId, adjustment: 1, reason: "parallel-increment" },
        testAdminActor,
      ),
    );

    const results = await Promise.all(adjusts);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    const levels = await kernel.services.inventory.getLevelsByEntityId(
      entityId,
      undefined,
      testAdminActor,
    );
    expect(levels.ok).toBe(true);
    if (!levels.ok) return;

    const level = levels.value.find((l) => l.warehouseId === warehouseId);
    expect(level).toBeDefined();
    if (!level) return;

    expect(level.quantityOnHand).toBe(STARTING_QTY + N);
    expect(level.version).toBe(N);
  });
});
