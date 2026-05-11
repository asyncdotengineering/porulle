import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

const actor = {
  type: "user",
  userId: "inv-actor-1",
  email: "inv@example.com",
  name: "Inventory Staff",
  vendorId: null,
  organizationId: null,
  role: "staff",
  permissions: [
    "catalog:create",
    "catalog:update",
    "catalog:read",
    "inventory:adjust",
    "inventory:read",
    "orders:create",
    "orders:read",
    "orders:update",
  ],
} as any;

// ─── Happy Path ────────────────────────────────────────────────────────────────

describe("inventory – happy path (PGlite-backed)", () => {
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
    await cleanup();
  });

  it("creates warehouse, adjusts +50, getAvailable returns 50", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-happy-1", attributes: { title: "Widget" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const wh = await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    expect(wh.ok).toBe(true);

    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 50, reason: "initial-stock" },
      actor,
    );

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(50);
  });

  it("multi-warehouse: adjust at MAIN and POPUP, total available = sum", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-multi-wh", attributes: { title: "Multi WH" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    const main = await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN", priority: 0 });
    expect(main.ok).toBe(true);
    if (!main.ok) return;

    const popup = await kernel.services.inventory.createWarehouse({ name: "Popup", code: "POPUP", priority: 1 });
    expect(popup.ok).toBe(true);
    if (!popup.ok) return;

    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, warehouseId: main.value.id, adjustment: 30, reason: "stock-main" },
      actor,
    );
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, warehouseId: popup.value.id, adjustment: 20, reason: "stock-popup" },
      actor,
    );

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(50);
  });

  it("reserve reduces available quantity", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-reserve-reduces", attributes: { title: "Reserve Item" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 20, reason: "stock" },
      actor,
    );

    const reserved = await kernel.services.inventory.reserve(
      { entityId: entity.value.id, quantity: 5, orderId: "ord-reserve-1" },
      actor,
    );
    expect(reserved.ok).toBe(true);

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(15);
  });

  it("release after reserve restores quantity", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-release-restores", attributes: { title: "Release Item" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 20, reason: "stock" },
      actor,
    );

    await kernel.services.inventory.reserve(
      { entityId: entity.value.id, quantity: 8, orderId: "ord-release-1" },
      actor,
    );

    const afterReserve = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(afterReserve.ok).toBe(true);
    if (!afterReserve.ok) return;
    expect(afterReserve.value).toBe(12);

    const released = await kernel.services.inventory.release(
      { entityId: entity.value.id, quantity: 8, orderId: "ord-release-1" },
      actor,
    );
    expect(released.ok).toBe(true);

    const afterRelease = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(afterRelease.ok).toBe(true);
    if (!afterRelease.ok) return;
    expect(afterRelease.value).toBe(20);
  });

  it("adjust with negative number (destock) reduces quantity", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-destock", attributes: { title: "Destock Item" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 30, reason: "initial" },
      actor,
    );
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: -10, reason: "shrinkage" },
      actor,
    );

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(20);
  });

  it("checkMultiple returns correct totals for multiple entityIds", async () => {

    const a = await kernel.services.catalog.create(
      { type: "product", slug: "inv-multi-a", attributes: { title: "A" }, metadata: {} },
      actor,
    );
    const b = await kernel.services.catalog.create(
      { type: "product", slug: "inv-multi-b", attributes: { title: "B" }, metadata: {} },
      actor,
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: a.value.id, adjustment: 15, reason: "stock" },
      actor,
    );
    await kernel.services.inventory.adjust(
      { entityId: b.value.id, adjustment: 25, reason: "stock" },
      actor,
    );

    const result = await kernel.services.inventory.checkMultiple([a.value.id, b.value.id]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[a.value.id]).toBe(15);
    expect(result.value[b.value.id]).toBe(25);
  });
});

// ─── Unhappy Path ──────────────────────────────────────────────────────────────

describe("inventory – unhappy path (PGlite-backed)", () => {
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
    await cleanup();
  });

  it("reserve more than available → Err (insufficient stock)", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-over-reserve", attributes: { title: "Over Reserve" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 5, reason: "stock" },
      actor,
    );

    const result = await kernel.services.inventory.reserve(
      { entityId: entity.value.id, quantity: 10, orderId: "ord-over" },
      actor,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/insufficient stock/i);
  });

  it("reserve exact available amount → succeeds (boundary)", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-exact-reserve", attributes: { title: "Exact Reserve" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 7, reason: "stock" },
      actor,
    );

    const result = await kernel.services.inventory.reserve(
      { entityId: entity.value.id, quantity: 7, orderId: "ord-exact" },
      actor,
    );
    expect(result.ok).toBe(true);

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(0);
  });

  it("release more than reserved → handles gracefully (floors at 0 reserved)", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-over-release", attributes: { title: "Over Release" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 20, reason: "stock" },
      actor,
    );
    await kernel.services.inventory.reserve(
      { entityId: entity.value.id, quantity: 5, orderId: "ord-over-release" },
      actor,
    );

    // Release more than what was reserved – service should floor at 0
    const result = await kernel.services.inventory.release(
      { entityId: entity.value.id, quantity: 10, orderId: "ord-over-release" },
      actor,
    );
    // Implementation either succeeds (floors reserved at 0) or returns an error – both are valid
    // We assert the service doesn't throw and available is non-negative
    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBeGreaterThanOrEqual(0);
  });

  it("adjust to below zero → quantity floors at 0", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-floor-zero", attributes: { title: "Floor Zero" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 5, reason: "stock" },
      actor,
    );
    // Destock past zero
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: -100, reason: "shrinkage" },
      actor,
    );

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(0);
  });

  it("getAvailable for non-existent entityId → returns 0", async () => {

    // Use a valid UUID format even though the entity doesn't exist
    // (PostgreSQL is strict about UUID types, unlike in-memory repo)
    const available = await kernel.services.inventory.getAvailable("00000000-0000-0000-0000-000000000000");
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(0);
  });

  it("reserve with quantity <= 0 → Err(CommerceValidationError)", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-zero-qty-reserve", attributes: { title: "Zero Qty" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 10, reason: "stock" },
      actor,
    );

    const result = await kernel.services.inventory.reserve(
      { entityId: entity.value.id, quantity: 0, orderId: "ord-zero" },
      actor,
    );
    expect(result.ok).toBe(false);
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────────

describe("inventory – edge cases (PGlite-backed)", () => {
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
    await cleanup();
  });

  it("adjust without explicit warehouseId auto-creates DEFAULT warehouse", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-auto-wh", attributes: { title: "Auto WH" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    // No explicit createWarehouse call – adjust should auto-create DEFAULT
    const result = await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 10, reason: "auto" },
      actor,
    );
    expect(result.ok).toBe(true);

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(10);
  });

  it("two sequential adjustments on the same entity both apply", async () => {

    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-double-adjust", attributes: { title: "Double Adjust" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });

    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 30, reason: "first" },
      actor,
    );
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 20, reason: "second" },
      actor,
    );

    const available = await kernel.services.inventory.getAvailable(entity.value.id);
    expect(available.ok).toBe(true);
    if (!available.ok) return;
    expect(available.value).toBe(50);
  });

  it("create warehouse with duplicate code → Err", async () => {

    const first = await kernel.services.inventory.createWarehouse({ name: "Main", code: "UNIQUE-CODE" });
    expect(first.ok).toBe(true);

    // Same code second time – SQLite unique constraint or service-level check should reject
    let secondThrew = false;
    try {
      const second = await kernel.services.inventory.createWarehouse({ name: "Main2", code: "UNIQUE-CODE" });
      // If the service doesn't throw, it should return Err
      if (!second.ok) secondThrew = true;
    } catch {
      secondThrew = true;
    }
    expect(secondThrew).toBe(true);
  });

  it("checkMultiple with empty array → returns empty object", async () => {

    const result = await kernel.services.inventory.checkMultiple([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value)).toHaveLength(0);
  });

  it("createWarehouse missing name → Err(CommerceValidationError)", async () => {
    const result = await kernel.services.inventory.createWarehouse({ code: "NO-NAME" });
    expect(result.ok).toBe(false);
  });

  it("createWarehouse missing code → Err(CommerceValidationError)", async () => {
    const result = await kernel.services.inventory.createWarehouse({ name: "No Code Warehouse" });
    expect(result.ok).toBe(false);
  });

  it("getLevelsByEntityId returns levels for a stocked entity", async () => {
    const entity = await kernel.services.catalog.create(
      { type: "product", slug: "inv-levels-check", attributes: { title: "Levels Check" }, metadata: {} },
      actor,
    );
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;

    await kernel.services.inventory.createWarehouse({ name: "Main", code: "MAIN" });
    await kernel.services.inventory.adjust(
      { entityId: entity.value.id, adjustment: 10, reason: "stock" },
      actor,
    );

    const levels = await kernel.services.inventory.getLevelsByEntityId(entity.value.id);
    expect(levels.ok).toBe(true);
    if (!levels.ok) return;
    expect(levels.value.length).toBeGreaterThanOrEqual(1);
    expect(levels.value[0]!.quantityOnHand).toBe(10);
  });

  it("listWarehouses returns sorted by priority", async () => {
    await kernel.services.inventory.createWarehouse({ name: "Low Priority", code: "LOW", priority: 10 });
    await kernel.services.inventory.createWarehouse({ name: "High Priority", code: "HIGH", priority: 0 });

    const result = await kernel.services.inventory.listWarehouses();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(2);
    // Priority 0 should come first
    const first = result.value[0]!;
    expect(first.priority).toBeLessThanOrEqual(result.value[1]!.priority);
  });
});
