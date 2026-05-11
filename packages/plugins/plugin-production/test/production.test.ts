import { describe, it, expect, beforeAll } from "vitest";
import type { PluginTestApp } from "@porulle/core/testing";
import { createPluginTestApp, jsonHeaders, testNoPermActor, productionAdminActor, productionCreatorActor, productionReaderActor } from "./test-utils.js";
import { productionPlugin } from "../src/index.js";

// Fixed UUIDs for ingredient entities
const PATTY_ENTITY = "a0000000-0000-4000-8000-000000000001";
const BUN_ENTITY = "a0000000-0000-4000-8000-000000000002";
const LETTUCE_ENTITY = "a0000000-0000-4000-8000-000000000003";
const TOMATO_ENTITY = "a0000000-0000-4000-8000-000000000004";
const ONION_ENTITY = "a0000000-0000-4000-8000-000000000005";
const SAUCE_ENTITY = "a0000000-0000-4000-8000-000000000006";
const CHEESE_ENTITY = "a0000000-0000-4000-8000-000000000007";
const KETCHUP_ENTITY = "a0000000-0000-4000-8000-000000000008";
const MAYO_ENTITY = "a0000000-0000-4000-8000-000000000009";
const BURGER_ENTITY = "a0000000-0000-4000-8000-000000000010";
const WAREHOUSE_ID = "b0000000-0000-4000-8000-000000000001";

describe("Production Plugin", () => {
  let app: PluginTestApp["app"];
  let simpleBomId: string;
  let sauceBomId: string;
  let condimentBomId: string;
  let parentBomId: string;
  let threeLevelBomId: string;
  let orderId: string;

  beforeAll(async () => {
    const result = await createPluginTestApp(productionPlugin());
    app = result.app;
  }, 30_000);

  // --- BOM Tests ---

  it("creates single-level BOM (Burger: patty + bun + lettuce) -> 201", async () => {
    const res = await app.request("http://localhost/api/production/boms", {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
      body: JSON.stringify({
        entityId: BURGER_ENTITY,
        name: "Classic Burger",
        yieldQuantity: 1,
        items: [
          { entityId: PATTY_ENTITY, itemName: "Beef Patty", quantity: 1, unitCost: 350 },
          { entityId: BUN_ENTITY, itemName: "Burger Bun", quantity: 1, unitCost: 80 },
          { entityId: LETTUCE_ENTITY, itemName: "Lettuce", quantity: 1, unitCost: 30 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    simpleBomId = body.data.id;
    expect(body.data.totalCost).toBe(460);
    expect(body.data.items.length).toBe(3);
  });

  it("creates sub-assembly BOM (Sauce: tomato + onion = 30) -> 201", async () => {
    const res = await app.request("http://localhost/api/production/boms", {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
      body: JSON.stringify({
        entityId: SAUCE_ENTITY,
        name: "Special Sauce",
        yieldQuantity: 1,
        level: 1,
        items: [
          { entityId: TOMATO_ENTITY, itemName: "Tomato", quantity: 1, unitCost: 20 },
          { entityId: ONION_ENTITY, itemName: "Onion", quantity: 1, unitCost: 10 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    sauceBomId = body.data.id;
    expect(body.data.totalCost).toBe(30);
  });

  it("creates level-2 sub-assembly BOM (Condiment: ketchup + mayo = 50) -> 201", async () => {
    const res = await app.request("http://localhost/api/production/boms", {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
      body: JSON.stringify({
        entityId: CHEESE_ENTITY,
        name: "Condiment Mix",
        yieldQuantity: 1,
        level: 2,
        items: [
          { entityId: KETCHUP_ENTITY, itemName: "Ketchup", quantity: 1, unitCost: 25 },
          { entityId: MAYO_ENTITY, itemName: "Mayo", quantity: 1, unitCost: 25 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    condimentBomId = body.data.id;
    expect(body.data.totalCost).toBe(50);
  });

  it("creates parent BOM with sub-assembly (Burger + Sauce) -> 201", async () => {
    const res = await app.request("http://localhost/api/production/boms", {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
      body: JSON.stringify({
        entityId: BURGER_ENTITY,
        name: "Burger with Sauce",
        yieldQuantity: 1,
        items: [
          { entityId: PATTY_ENTITY, itemName: "Beef Patty", quantity: 1, unitCost: 350 },
          { entityId: BUN_ENTITY, itemName: "Burger Bun", quantity: 1, unitCost: 80 },
          { entityId: SAUCE_ENTITY, itemName: "Special Sauce", quantity: 1, unitCost: 0, isSubAssembly: true, subBomId: sauceBomId },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    parentBomId = body.data.id;
    // Sub-assembly resolved: patty(350) + bun(80) + sauce(30/1=30) = 460
    expect(body.data.totalCost).toBe(460);
  });

  it("creates 3-level BOM (Burger + Sauce sub-assembly that includes Condiment sub-assembly) -> 201", async () => {
    // First, create a sauce BOM that references condiment as sub-assembly
    const sauceWithCondimentRes = await app.request("http://localhost/api/production/boms", {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
      body: JSON.stringify({
        entityId: SAUCE_ENTITY,
        name: "Sauce with Condiment",
        yieldQuantity: 1,
        level: 1,
        items: [
          { entityId: TOMATO_ENTITY, itemName: "Tomato", quantity: 1, unitCost: 20 },
          { entityId: CHEESE_ENTITY, itemName: "Condiment Mix", quantity: 1, unitCost: 0, isSubAssembly: true, subBomId: condimentBomId },
        ],
      }),
    });
    expect(sauceWithCondimentRes.status).toBe(201);
    const sauceWithCondimentBody = await sauceWithCondimentRes.json();
    const sauceWithCondimentBomId = sauceWithCondimentBody.data.id;
    // tomato(20) + condiment(50) = 70
    expect(sauceWithCondimentBody.data.totalCost).toBe(70);

    // Now create the 3-level BOM
    const res = await app.request("http://localhost/api/production/boms", {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
      body: JSON.stringify({
        entityId: BURGER_ENTITY,
        name: "Ultimate Burger (3-level)",
        yieldQuantity: 1,
        items: [
          { entityId: PATTY_ENTITY, itemName: "Beef Patty", quantity: 1, unitCost: 350 },
          { entityId: SAUCE_ENTITY, itemName: "Sauce with Condiment", quantity: 1, unitCost: 0, isSubAssembly: true, subBomId: sauceWithCondimentBomId },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    threeLevelBomId = body.data.id;
    // patty(350) + sauce_with_condiment(70) = 420
    expect(body.data.totalCost).toBe(420);
  });

  it("gets BOM with items -> 200", async () => {
    const res = await app.request(`http://localhost/api/production/boms/${simpleBomId}`, {
      headers: jsonHeaders(productionReaderActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("Classic Burger");
    expect(body.data.items.length).toBe(3);
  });

  it("lists BOMs -> 200", async () => {
    const res = await app.request("http://localhost/api/production/boms", {
      headers: jsonHeaders(productionReaderActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("adds item to existing BOM -> 201", async () => {
    const res = await app.request(`http://localhost/api/production/boms/${simpleBomId}/items`, {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
      body: JSON.stringify({
        entityId: CHEESE_ENTITY,
        itemName: "Cheese Slice",
        quantity: 1,
        unitCost: 40,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.itemName).toBe("Cheese Slice");
    expect(body.data.totalCost).toBe(40);

    // Verify BOM total updated
    const bomRes = await app.request(`http://localhost/api/production/boms/${simpleBomId}`, {
      headers: jsonHeaders(productionReaderActor),
    });
    const bomBody = await bomRes.json();
    expect(bomBody.data.items.length).toBe(4);
    expect(bomBody.data.totalCost).toBe(500); // 460 + 40
  });

  it("cost rollup resolves sub-assembly cost -> 200", async () => {
    const res = await app.request(`http://localhost/api/production/boms/${parentBomId}/cost-rollup`, {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // patty(350) + bun(80) + sauce(30) = 460
    expect(body.data.totalCost).toBe(460);
  });

  it("cost rollup through 3-level BOM -> correct total", async () => {
    const res = await app.request(`http://localhost/api/production/boms/${threeLevelBomId}/cost-rollup`, {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // patty(350) + sauce_with_condiment(tomato:20 + condiment(ketchup:25 + mayo:25)=50 => 70) = 420
    expect(body.data.totalCost).toBe(420);
  });

  it("BOM explosion for 50 burgers -> flat material list", async () => {
    const res = await app.request(`http://localhost/api/production/boms/${parentBomId}/explode`, {
      method: "POST",
      headers: jsonHeaders(productionReaderActor),
      body: JSON.stringify({ quantity: 50 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const materials = body.data as Array<{ entityId: string; itemName: string; totalQuantity: number; unitCost: number; totalCost: number }>;

    // Should have 4 raw materials: patty, bun, tomato, onion
    expect(materials.length).toBe(4);

    const patty = materials.find(m => m.entityId === PATTY_ENTITY)!;
    expect(patty.totalQuantity).toBe(50);
    expect(patty.totalCost).toBe(50 * 350);

    const bun = materials.find(m => m.entityId === BUN_ENTITY)!;
    expect(bun.totalQuantity).toBe(50);

    const tomato = materials.find(m => m.entityId === TOMATO_ENTITY)!;
    expect(tomato.totalQuantity).toBe(50);
    expect(tomato.totalCost).toBe(50 * 20);

    const onion = materials.find(m => m.entityId === ONION_ENTITY)!;
    expect(onion.totalQuantity).toBe(50);
    expect(onion.totalCost).toBe(50 * 10);
  });

  it("BOM explosion through 3-level BOM flattens all raw materials", async () => {
    const res = await app.request(`http://localhost/api/production/boms/${threeLevelBomId}/explode`, {
      method: "POST",
      headers: jsonHeaders(productionReaderActor),
      body: JSON.stringify({ quantity: 10 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const materials = body.data as Array<{ entityId: string; itemName: string; totalQuantity: number; totalCost: number }>;

    // Should have 3 raw materials: patty, tomato, ketchup, mayo
    expect(materials.length).toBe(4);

    const patty = materials.find(m => m.entityId === PATTY_ENTITY)!;
    expect(patty.totalQuantity).toBe(10);

    const tomato = materials.find(m => m.entityId === TOMATO_ENTITY)!;
    expect(tomato.totalQuantity).toBe(10);

    const ketchup = materials.find(m => m.entityId === KETCHUP_ENTITY)!;
    expect(ketchup.totalQuantity).toBe(10);

    const mayo = materials.find(m => m.entityId === MAYO_ENTITY)!;
    expect(mayo.totalQuantity).toBe(10);
  });

  // --- Production Order Tests ---

  it("creates production order -> 201", async () => {
    const res = await app.request("http://localhost/api/production/orders", {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({
        bomId: simpleBomId,
        entityId: BURGER_ENTITY,
        quantity: 100,
        warehouseId: WAREHOUSE_ID,
        plannedDate: "2026-04-01T08:00:00Z",
        notes: "Morning batch",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    orderId = body.data.id;
    expect(body.data.status).toBe("planned");
    expect(body.data.quantity).toBe(100);
    expect(body.data.orderNumber).toBe("PRD-0001");
  });

  it("lists orders -> 200", async () => {
    const res = await app.request("http://localhost/api/production/orders", {
      headers: jsonHeaders(productionReaderActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("lists orders filtered by status -> 200", async () => {
    const res = await app.request("http://localhost/api/production/orders?status=planned", {
      headers: jsonHeaders(productionReaderActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("gets order by id with empty consumption -> 200", async () => {
    const res = await app.request(`http://localhost/api/production/orders/${orderId}`, {
      headers: jsonHeaders(productionReaderActor),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(orderId);
    expect(body.data.consumption).toHaveLength(0);
  });

  it("starts production order: planned -> in_progress -> 201", async () => {
    const res = await app.request(`http://localhost/api/production/orders/${orderId}/start`, {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({ producedBy: "Chef John" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("in_progress");
    expect(body.data.producedBy).toBe("Chef John");
    expect(body.data.startedAt).toBeTruthy();
  });

  it("records consumption for in_progress order -> 201", async () => {
    const res = await app.request(`http://localhost/api/production/orders/${orderId}/consume`, {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({
        items: [
          { entityId: PATTY_ENTITY, plannedQuantity: 100, actualQuantity: 98, unitCost: 350, batchNumber: "BATCH-P001" },
          { entityId: BUN_ENTITY, plannedQuantity: 100, actualQuantity: 100, unitCost: 80 },
          { entityId: LETTUCE_ENTITY, plannedQuantity: 100, actualQuantity: 105, unitCost: 30 },
          { entityId: CHEESE_ENTITY, plannedQuantity: 100, actualQuantity: 100, unitCost: 40 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.length).toBe(4);
    // Verify total cost calculation
    const pattyConsumption = body.data.find((c: Record<string, unknown>) => c.entityId === PATTY_ENTITY);
    expect(pattyConsumption.totalCost).toBe(98 * 350);
    expect(pattyConsumption.batchNumber).toBe("BATCH-P001");
  });

  it("cannot record consumption for planned order -> error", async () => {
    // Create a new order that stays planned
    const createRes = await app.request("http://localhost/api/production/orders", {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({
        bomId: simpleBomId,
        entityId: BURGER_ENTITY,
        quantity: 10,
        warehouseId: WAREHOUSE_ID,
        plannedDate: "2026-04-05T08:00:00Z",
      }),
    });
    const plannedOrderId = (await createRes.json()).data.id;

    const res = await app.request(`http://localhost/api/production/orders/${plannedOrderId}/consume`, {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({
        items: [
          { entityId: PATTY_ENTITY, plannedQuantity: 10, actualQuantity: 10, unitCost: 350 },
        ],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("completes production order with consumption records -> 201", async () => {
    const res = await app.request(`http://localhost/api/production/orders/${orderId}/complete`, {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("completed");
    expect(body.data.completedAt).toBeTruthy();
    // Should include existing consumption records
    expect(body.data.consumption.length).toBe(4);
  });

  it("complete auto-generates consumption when none recorded -> 201", async () => {
    // Create, start, and complete without explicit consumption
    const createRes = await app.request("http://localhost/api/production/orders", {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({
        bomId: simpleBomId,
        entityId: BURGER_ENTITY,
        quantity: 50,
        warehouseId: WAREHOUSE_ID,
        plannedDate: "2026-04-03T08:00:00Z",
      }),
    });
    const autoOrderId = (await createRes.json()).data.id;

    await app.request(`http://localhost/api/production/orders/${autoOrderId}/start`, {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({ producedBy: "Chef Auto" }),
    });

    const completeRes = await app.request(`http://localhost/api/production/orders/${autoOrderId}/complete`, {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
    });
    expect(completeRes.status).toBe(201);
    const completeBody = await completeRes.json();
    expect(completeBody.data.status).toBe("completed");
    // Auto-generated consumption records from BOM items (4 items since we added cheese)
    expect(completeBody.data.consumption.length).toBe(4);

    // Verify quantities are correct (50 units * BOM quantities)
    const pattyC = completeBody.data.consumption.find((c: Record<string, unknown>) => c.entityId === PATTY_ENTITY);
    expect(pattyC.plannedQuantity).toBe(50);
    expect(pattyC.actualQuantity).toBe(50);
    expect(pattyC.totalCost).toBe(50 * 350);
  });

  it("cannot cancel completed order -> error", async () => {
    const res = await app.request(`http://localhost/api/production/orders/${orderId}/cancel`, {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("cancel planned order -> 201", async () => {
    // Create a new order to cancel
    const createRes = await app.request("http://localhost/api/production/orders", {
      method: "POST",
      headers: jsonHeaders(productionCreatorActor),
      body: JSON.stringify({
        bomId: simpleBomId,
        entityId: BURGER_ENTITY,
        quantity: 25,
        warehouseId: WAREHOUSE_ID,
        plannedDate: "2026-04-02T08:00:00Z",
      }),
    });
    const createBody = await createRes.json();
    const cancelOrderId = createBody.data.id;

    const res = await app.request(`http://localhost/api/production/orders/${cancelOrderId}/cancel`, {
      method: "POST",
      headers: jsonHeaders(productionAdminActor),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.status).toBe("cancelled");
  });

  // --- Auth & Isolation ---

  it("no permission -> 403", async () => {
    const res = await app.request("http://localhost/api/production/boms", {
      method: "POST",
      headers: jsonHeaders(testNoPermActor),
      body: JSON.stringify({
        entityId: BURGER_ENTITY,
        name: "Forbidden BOM",
        items: [{ entityId: PATTY_ENTITY, itemName: "Patty", quantity: 1, unitCost: 100 }],
      }),
    });
    expect(res.status).toBe(403);
  });

  it("org isolation: different org sees 0 BOMs", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff", permissions: ["production:read"],
    };
    const res = await app.request("http://localhost/api/production/boms", {
      headers: jsonHeaders(otherOrg),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });

  it("org isolation: different org sees 0 orders", async () => {
    const otherOrg: import("@porulle/core").Actor = {
      type: "user", userId: "other", email: "o@o.local", name: "Other",
      vendorId: null, organizationId: "org_other", role: "staff", permissions: ["production:read"],
    };
    const res = await app.request("http://localhost/api/production/orders", {
      headers: jsonHeaders(otherOrg),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.length).toBe(0);
  });
});
