/**
 * RecipeDeductionService -- resolves recipe ingredient inventory deductions
 * when a POS transaction completes.
 *
 * For each sold item:
 *   1. Look up the entity's active recipe
 *   2. For each ingredient with an entityId, calculate deduction quantity
 *   3. Deduct via inventory service (preferred) or raw SQL (fallback)
 *
 * When the ServiceRegistry is provided (normal plugin boot), deductions
 * go through kernel.services.inventory.adjust() which creates proper
 * movements, fires hooks, and respects audit trail.
 *
 * When the ServiceRegistry is not available (standalone tests, scripts),
 * falls back to raw SQL with the same atomic guard.
 */

import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { posRecipes, posRecipeIngredients } from "../schema.js";
import type { Db } from "../types.js";

/** Minimal interface for the inventory service methods we need. */
interface InventoryAdjustFn {
  adjust(
    input: { entityId: string; warehouseId?: string; adjustment: number; reason?: string },
    actor?: unknown,
  ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
}

interface DeductionItem {
  entityId: string;
  variantId: string | null;
  quantity: number;
  unit: string;
  itemName: string;
  reason: string;
}

export class RecipeDeductionService {
  private inventorySvc?: InventoryAdjustFn;

  constructor(
    private db: Db,
    services?: Record<string, unknown>,
  ) {
    // Extract inventory service if available
    if (services?.inventory && typeof (services.inventory as Record<string, unknown>).adjust === "function") {
      this.inventorySvc = services.inventory as InventoryAdjustFn;
    }
  }

  /**
   * Resolve all recipe ingredient deductions for a list of sold items.
   * Pure query -- no mutations. Returns a flat list to pass to applyDeductions().
   */
  async resolveDeductions(
    orgId: string,
    items: Array<{ entityId: string; quantity: number }>,
  ): Promise<PluginResult<DeductionItem[]>> {
    const deductions: DeductionItem[] = [];

    for (const item of items) {
      const recipes = await this.db
        .select()
        .from(posRecipes)
        .where(and(
          eq(posRecipes.organizationId, orgId),
          eq(posRecipes.entityId, item.entityId),
          eq(posRecipes.isActive, true),
        ));

      if (recipes.length === 0) continue;
      const recipe = recipes[0]!;

      const ingredients = await this.db
        .select()
        .from(posRecipeIngredients)
        .where(eq(posRecipeIngredients.recipeId, recipe.id));

      for (const ing of ingredients) {
        if (ing.entityId == null) continue;

        const deductQty = Math.ceil((ing.quantity * item.quantity) / recipe.yieldQuantity);

        deductions.push({
          entityId: ing.entityId,
          variantId: ing.variantId ?? null,
          quantity: deductQty,
          unit: ing.unit,
          itemName: ing.ingredientName,
          reason: `Recipe: ${deductQty}${ing.unit} ${ing.ingredientName} for ${item.quantity}x ${recipe.name}`,
        });
      }
    }

    return Ok(deductions);
  }

  /**
   * Apply deductions to inventory.
   *
   * Strategy 1 (preferred): Use inventory.adjust() via ServiceRegistry.
   *   - Creates proper inventory_movements with audit trail
   *   - Fires hooks (e.g., low-stock alerts)
   *   - Respects the inventory service's stock guard logic
   *
   * Strategy 2 (fallback): Raw SQL with atomic WHERE guard.
   *   - Used when services are not available (standalone scripts, tests)
   *   - Same oversell protection via UPDATE ... WHERE quantity_on_hand >= N
   */
  async applyDeductions(
    tx: Db,
    deductions: DeductionItem[],
    warehouseId: string,
    referenceType: string,
    referenceId: string,
    performedBy: string,
    orgId?: string,
  ): Promise<PluginResult<number>> {
    if (this.inventorySvc) {
      return this.applyViaService(deductions, warehouseId, performedBy);
    }

    const resolvedOrgId = orgId ?? await this.resolveOrgIdFromWarehouse(tx, warehouseId);
    if (!resolvedOrgId) return Err("Warehouse not found");

    return this.applyViaRawSQL(
      tx,
      deductions,
      warehouseId,
      referenceType,
      referenceId,
      performedBy,
      resolvedOrgId,
    );
  }

  private async resolveOrgIdFromWarehouse(tx: Db, warehouseId: string): Promise<string | null> {
    const result = await tx.execute(
      sql`SELECT organization_id FROM warehouses WHERE id = ${warehouseId} LIMIT 1`,
    );
    const rows = Array.isArray(result)
      ? result as Array<{ organization_id: string }>
      : (result as { rows: Array<{ organization_id: string }> }).rows;
    return rows[0]?.organization_id ?? null;
  }

  /**
   * Strategy 1: Deduct via kernel.services.inventory.adjust().
   * Each deduction becomes a negative adjustment with a reason.
   */
  private async applyViaService(
    deductions: DeductionItem[],
    warehouseId: string,
    performedBy: string,
  ): Promise<PluginResult<number>> {
    const inventory = this.inventorySvc!;
    const systemActor = {
      type: "system" as const,
      userId: performedBy,
      email: null,
      name: "Recipe Deduction",
      vendorId: null,
      organizationId: null,
      role: "system",
      permissions: ["inventory:adjust"],
    };

    let applied = 0;

    for (const d of deductions) {
      const result = await inventory.adjust(
        {
          entityId: d.entityId,
          warehouseId,
          adjustment: -d.quantity,
          reason: d.reason,
        },
        systemActor,
      );

      if (result.ok) {
        applied++;
      }
      // If adjust fails (insufficient stock), it returns ok: false
      // and the deduction is skipped -- same behavior as raw SQL guard
    }

    return Ok(applied);
  }

  /**
   * Strategy 2: Raw SQL fallback with atomic oversell guard.
   * Used when ServiceRegistry is not available.
   */
  private async applyViaRawSQL(
    tx: Db,
    deductions: DeductionItem[],
    warehouseId: string,
    referenceType: string,
    referenceId: string,
    performedBy: string,
    orgId: string,
  ): Promise<PluginResult<number>> {
    let applied = 0;
    // PluginDb (PgDatabase) has .execute() — no cast needed
    const exec = tx;

    for (const d of deductions) {
      const variantClause = d.variantId != null
        ? sql`variant_id = ${d.variantId}`
        : sql`variant_id IS NULL`;

      // Atomic guard: only deduct if sufficient stock
      const updateResult = await exec.execute(
        sql`UPDATE inventory_levels
            SET quantity_on_hand = quantity_on_hand - ${d.quantity}, updated_at = NOW()
            WHERE entity_id = ${d.entityId} AND warehouse_id = ${warehouseId} AND ${variantClause}
              AND organization_id = ${orgId}
              AND quantity_on_hand >= ${d.quantity}
            RETURNING quantity_on_hand`,
      );

      const rows = Array.isArray(updateResult) ? updateResult : (updateResult as { rows: unknown[] }).rows;
      if (rows.length === 0) {
        await exec.execute(
          sql`INSERT INTO inventory_movements (entity_id, variant_id, warehouse_id, organization_id, type, quantity, reference_type, reference_id, reason, performed_by)
              VALUES (${d.entityId}, ${d.variantId}, ${warehouseId}, ${orgId}, 'sale', ${0}, ${referenceType}, ${referenceId}, ${"SKIPPED: insufficient stock for " + d.reason}, ${performedBy})`,
        );
        continue;
      }

      await exec.execute(
        sql`INSERT INTO inventory_movements (entity_id, variant_id, warehouse_id, organization_id, type, quantity, reference_type, reference_id, reason, performed_by)
            VALUES (${d.entityId}, ${d.variantId}, ${warehouseId}, ${orgId}, 'sale', ${-d.quantity}, ${referenceType}, ${referenceId}, ${d.reason}, ${performedBy})`,
      );

      applied++;
    }

    return Ok(applied);
  }
}
