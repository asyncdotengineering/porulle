import { describe, it, expect, beforeAll } from "vitest";
import { eq, sql } from "@porulle/core/drizzle";
import { TEST_ORG_ID } from "@porulle/core/testing";
import { organization, inventoryLevels, inventoryMovements } from "@porulle/core/schema";
import { posRestaurantPlugin } from "../src/index.js";
import { RecipeDeductionService } from "../src/services/recipe-deduction-service.js";
import { RecipeService } from "../src/services/recipe-service.js";
import { createPluginTestApp, testAdminActor } from "./test-utils.js";

const ORG_B = "org_recipe_deduction_b";

describe("RecipeDeductionService raw SQL fallback (SEC-raw-sql)", () => {
  let db: Awaited<ReturnType<typeof createPluginTestApp>>["db"];
  let kernel: Awaited<ReturnType<typeof createPluginTestApp>>["kernel"];

  beforeAll(async () => {
    const result = await createPluginTestApp(posRestaurantPlugin());
    db = result.db;
    kernel = result.kernel;

    await db.insert(organization).values({
      id: ORG_B,
      name: "Recipe Deduction Org B",
      slug: "recipe-deduction-b",
      createdAt: new Date(),
    });
  }, 30_000);

  it("raw-SQL path inserts inventory_movements with organization_id and scopes level updates", async () => {
    const menuEntity = await kernel.services.catalog.create(
      { type: "product", slug: `menu-${Date.now()}`, attributes: { title: "Test Burger" }, metadata: {} },
      testAdminActor,
    );
    expect(menuEntity.ok).toBe(true);
    if (!menuEntity.ok) return;

    const ingredientEntity = await kernel.services.catalog.create(
      { type: "product", slug: `beef-${Date.now()}`, attributes: { title: "Beef Patty" }, metadata: {} },
      testAdminActor,
    );
    expect(ingredientEntity.ok).toBe(true);
    if (!ingredientEntity.ok) return;

    const warehouse = await kernel.services.inventory.createWarehouse(
      { name: "Kitchen", code: `RD-${Date.now()}` },
      testAdminActor,
    );
    expect(warehouse.ok).toBe(true);
    if (!warehouse.ok) return;

    const seed = await kernel.services.inventory.adjust(
      {
        entityId: ingredientEntity.value.id,
        warehouseId: warehouse.value.id,
        adjustment: 100,
        reason: "seed",
      },
      testAdminActor,
    );
    expect(seed.ok).toBe(true);

    const recipeService = new RecipeService(db);
    const recipe = await recipeService.createRecipe(TEST_ORG_ID, {
      entityId: menuEntity.value.id,
      name: "Burger BOM",
      yieldQuantity: 1,
      ingredients: [
        {
          ingredientName: "Beef Patty",
          quantity: 10,
          unit: "g",
          costPerUnit: 1,
          entityId: ingredientEntity.value.id,
        },
      ],
    });
    expect(recipe.ok).toBe(true);

    await db.insert(inventoryLevels).values({
      organizationId: ORG_B,
      entityId: ingredientEntity.value.id,
      warehouseId: warehouse.value.id,
      quantityOnHand: 999,
    });

    const deductSvc = new RecipeDeductionService(db);
    const deductions = await deductSvc.resolveDeductions(TEST_ORG_ID, [
      { entityId: menuEntity.value.id, quantity: 1 },
    ]);
    expect(deductions.ok).toBe(true);
    if (!deductions.ok) return;

    const applied = await deductSvc.applyDeductions(
      db,
      deductions.value,
      warehouse.value.id,
      "pos_transaction",
      "txn-raw-sql-test",
      "cashier-1",
      TEST_ORG_ID,
    );
    expect(applied.ok).toBe(true);
    expect(applied.value).toBe(1);

    const movements = await db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.referenceId, "txn-raw-sql-test"));
    expect(movements.length).toBe(1);
    expect(movements[0]!.organizationId).toBe(TEST_ORG_ID);
    expect(movements[0]!.quantity).toBe(-10);

    const orgALevel = await db.execute(
      sql`SELECT quantity_on_hand::int AS qty FROM inventory_levels
          WHERE entity_id = ${ingredientEntity.value.id}
            AND warehouse_id = ${warehouse.value.id}
            AND organization_id = ${TEST_ORG_ID}`,
    );
    const orgARows = Array.isArray(orgALevel)
      ? orgALevel as Array<{ qty: number }>
      : (orgALevel as { rows: Array<{ qty: number }> }).rows;
    expect(orgARows[0]?.qty).toBe(90);

    const orgBLevel = await db.execute(
      sql`SELECT quantity_on_hand::int AS qty FROM inventory_levels
          WHERE entity_id = ${ingredientEntity.value.id}
            AND warehouse_id = ${warehouse.value.id}
            AND organization_id = ${ORG_B}`,
    );
    const orgBRows = Array.isArray(orgBLevel)
      ? orgBLevel as Array<{ qty: number }>
      : (orgBLevel as { rows: Array<{ qty: number }> }).rows;
    expect(orgBRows[0]?.qty).toBe(999);
  });
});