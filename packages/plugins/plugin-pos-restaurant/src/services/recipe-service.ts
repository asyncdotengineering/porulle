/**
 * RecipeService — Recipe/BOM management and COGS calculation.
 *
 * URY: Recipe mapping using Bill of Materials (BOM). Links menu items
 * to raw ingredients for COGS calculation in Daily P&L.
 * URY uses ERPNext's BOM doctype + Item Price for buying cost.
 *
 * Our implementation: pos_recipes + pos_recipe_ingredients tables.
 * COGS = sum(ingredient.quantity * ingredient.costPerUnit) / yieldQuantity.
 */

import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posRecipes, posRecipeIngredients } from "../schema.js";
import type { Db } from "../types.js";

export class RecipeService {
  constructor(private db: Db) {}

  async createRecipe(orgId: string, input: {
    entityId: string;
    name: string;
    yieldQuantity?: number;
    ingredients: Array<{
      ingredientName: string;
      quantity: number;
      unit: string;
      costPerUnit: number;
      entityId?: string;   // optional: link to inventory entity for deduction
      variantId?: string;  // optional: specific variant to deduct
    }>;
  }): Promise<PluginResult<{ id: string; name: string; costPerUnit: number }>> {
    const rows = await this.db
      .insert(posRecipes)
      .values({
        organizationId: orgId,
        entityId: input.entityId,
        name: input.name,
        yieldQuantity: input.yieldQuantity ?? 1,
      })
      .returning();

    const recipe = rows[0]!;

    let totalCost = 0;
    for (let i = 0; i < input.ingredients.length; i++) {
      const ing = input.ingredients[i]!;
      await this.db.insert(posRecipeIngredients).values({
        recipeId: recipe.id,
        ingredientName: ing.ingredientName,
        quantity: ing.quantity,
        unit: ing.unit,
        costPerUnit: ing.costPerUnit,
        entityId: ing.entityId,
        variantId: ing.variantId,
        sortOrder: i,
      });
      totalCost += ing.quantity * ing.costPerUnit;
    }

    const costPerUnit = Math.round(totalCost / (input.yieldQuantity ?? 1));

    return Ok({ id: recipe.id, name: recipe.name, costPerUnit });
  }

  async getRecipeWithIngredients(recipeId: string): Promise<PluginResult<{
    recipe: typeof posRecipes.$inferSelect;
    ingredients: Array<typeof posRecipeIngredients.$inferSelect>;
    totalCost: number;
    costPerUnit: number;
  }>> {
    const recipes = await this.db.select().from(posRecipes).where(eq(posRecipes.id, recipeId));
    if (recipes.length === 0) return Err("Recipe not found");
    const recipe = recipes[0]!;

    const ingredients = await this.db
      .select()
      .from(posRecipeIngredients)
      .where(eq(posRecipeIngredients.recipeId, recipeId))
      .orderBy(posRecipeIngredients.sortOrder);

    const totalCost = ingredients.reduce((sum, i) => sum + i.quantity * i.costPerUnit, 0);
    const costPerUnit = Math.round(totalCost / recipe.yieldQuantity);

    return Ok({ recipe, ingredients, totalCost, costPerUnit });
  }

  async calculateCOGS(orgId: string, entityId: string, quantity: number): Promise<number> {
    const recipes = await this.db
      .select()
      .from(posRecipes)
      .where(and(eq(posRecipes.organizationId, orgId), eq(posRecipes.entityId, entityId), eq(posRecipes.isActive, true)));

    if (recipes.length === 0) return 0;
    const recipe = recipes[0]!;

    const ingredients = await this.db
      .select()
      .from(posRecipeIngredients)
      .where(eq(posRecipeIngredients.recipeId, recipe.id));

    const costPerYield = ingredients.reduce((sum, i) => sum + i.quantity * i.costPerUnit, 0);
    const costPerUnit = costPerYield / recipe.yieldQuantity;
    return Math.round(costPerUnit * quantity);
  }

  async listRecipes(orgId: string): Promise<PluginResult<Array<typeof posRecipes.$inferSelect>>> {
    const rows = await this.db
      .select()
      .from(posRecipes)
      .where(eq(posRecipes.organizationId, orgId));
    return Ok(rows);
  }
}
