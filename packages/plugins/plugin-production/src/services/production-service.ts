import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { productionBoms, productionBomItems } from "../schema.js";
import type { Db, BOM, BOMItem } from "../types.js";

export interface ExplodedItem {
  entityId: string;
  itemName: string;
  totalQuantity: number;
  unitCost: number;
  totalCost: number;
}

export class ProductionService {
  constructor(private db: Db) {}

  async createBOM(orgId: string, input: {
    entityId: string;
    name: string;
    yieldQuantity?: number;
    yieldUomId?: string;
    level?: number;
    items: Array<{
      entityId: string;
      itemName: string;
      quantity: number;
      unitCost: number;
      uomId?: string;
      isSubAssembly?: boolean;
      subBomId?: string;
    }>;
  }): Promise<PluginResult<BOM & { items: BOMItem[] }>> {
    const yieldQty = input.yieldQuantity ?? 1;

    // Calculate total cost, resolving sub-assembly costs
    let totalCost = 0;
    const itemsWithCosts: Array<{
      entityId: string;
      itemName: string;
      quantity: number;
      unitCost: number;
      totalCost: number;
      uomId?: string | undefined;
      isSubAssembly: boolean;
      subBomId?: string | undefined;
      sortOrder: number;
    }> = [];

    for (let i = 0; i < input.items.length; i++) {
      const item = input.items[i]!;
      let unitCost = item.unitCost;

      if (item.isSubAssembly && item.subBomId) {
        const subBom = await this.db.select().from(productionBoms)
          .where(and(eq(productionBoms.id, item.subBomId), eq(productionBoms.organizationId, orgId)));
        if (subBom.length > 0) {
          const sub = subBom[0]!;
          unitCost = Math.round((sub.totalCost ?? 0) / (sub.yieldQuantity ?? 1));
        }
      }

      const itemTotal = item.quantity * unitCost;
      totalCost += itemTotal;

      itemsWithCosts.push({
        entityId: item.entityId,
        itemName: item.itemName,
        quantity: item.quantity,
        unitCost,
        totalCost: itemTotal,
        uomId: item.uomId,
        isSubAssembly: item.isSubAssembly ?? false,
        subBomId: item.subBomId,
        sortOrder: i,
      });
    }

    const bomRows = await this.db.insert(productionBoms).values({
      organizationId: orgId,
      entityId: input.entityId,
      name: input.name,
      yieldQuantity: yieldQty,
      yieldUomId: input.yieldUomId,
      level: input.level ?? 0,
      totalCost,
    }).returning();
    const bom = bomRows[0]!;

    const insertedItems: BOMItem[] = [];
    for (const item of itemsWithCosts) {
      const rows = await this.db.insert(productionBomItems).values({
        bomId: bom.id,
        entityId: item.entityId,
        itemName: item.itemName,
        quantity: item.quantity,
        unitCost: item.unitCost,
        totalCost: item.totalCost,
        uomId: item.uomId,
        isSubAssembly: item.isSubAssembly,
        subBomId: item.subBomId,
        sortOrder: item.sortOrder,
      }).returning();
      insertedItems.push(rows[0]!);
    }

    return Ok({ ...bom, items: insertedItems });
  }

  async getBOM(orgId: string, id: string): Promise<PluginResult<BOM & { items: BOMItem[] }>> {
    const boms = await this.db.select().from(productionBoms)
      .where(and(eq(productionBoms.id, id), eq(productionBoms.organizationId, orgId)));
    if (boms.length === 0) return Err("BOM not found");
    const bom = boms[0]!;

    const items = await this.db.select().from(productionBomItems)
      .where(eq(productionBomItems.bomId, id))
      .orderBy(productionBomItems.sortOrder);

    return Ok({ ...bom, items });
  }

  async listBOMs(orgId: string): Promise<PluginResult<BOM[]>> {
    const rows = await this.db.select().from(productionBoms)
      .where(eq(productionBoms.organizationId, orgId));
    return Ok(rows);
  }

  async addBOMItem(orgId: string, bomId: string, input: {
    entityId: string;
    itemName: string;
    quantity: number;
    unitCost: number;
    uomId?: string;
    isSubAssembly?: boolean;
    subBomId?: string;
  }): Promise<PluginResult<BOMItem>> {
    // Verify BOM exists and belongs to org
    const boms = await this.db.select().from(productionBoms)
      .where(and(eq(productionBoms.id, bomId), eq(productionBoms.organizationId, orgId)));
    if (boms.length === 0) return Err("BOM not found");

    let unitCost = input.unitCost;
    if (input.isSubAssembly && input.subBomId) {
      const subBom = await this.db.select().from(productionBoms)
        .where(and(eq(productionBoms.id, input.subBomId), eq(productionBoms.organizationId, orgId)));
      if (subBom.length > 0) {
        const sub = subBom[0]!;
        unitCost = Math.round((sub.totalCost ?? 0) / (sub.yieldQuantity ?? 1));
      }
    }

    const itemTotal = input.quantity * unitCost;

    // Get current max sort order
    const existingItems = await this.db.select().from(productionBomItems)
      .where(eq(productionBomItems.bomId, bomId));
    const maxSort = existingItems.reduce((max, i) => Math.max(max, i.sortOrder ?? 0), -1);

    const rows = await this.db.insert(productionBomItems).values({
      bomId,
      entityId: input.entityId,
      itemName: input.itemName,
      quantity: input.quantity,
      unitCost,
      totalCost: itemTotal,
      uomId: input.uomId,
      isSubAssembly: input.isSubAssembly ?? false,
      subBomId: input.subBomId,
      sortOrder: maxSort + 1,
    }).returning();

    // Recalculate BOM total cost
    const allItems = await this.db.select().from(productionBomItems)
      .where(eq(productionBomItems.bomId, bomId));
    const newTotal = allItems.reduce((sum, i) => sum + (i.totalCost ?? 0), 0);
    await this.db.update(productionBoms).set({
      totalCost: newTotal,
      updatedAt: new Date(),
    }).where(eq(productionBoms.id, bomId));

    return Ok(rows[0]!);
  }

  async costRollup(orgId: string, id: string): Promise<PluginResult<BOM>> {
    const boms = await this.db.select().from(productionBoms)
      .where(and(eq(productionBoms.id, id), eq(productionBoms.organizationId, orgId)));
    if (boms.length === 0) return Err("BOM not found");

    const items = await this.db.select().from(productionBomItems)
      .where(eq(productionBomItems.bomId, id));

    let totalCost = 0;
    for (const item of items) {
      let unitCost = item.unitCost ?? 0;

      if (item.isSubAssembly && item.subBomId) {
        // Recursively roll up sub-assembly first
        const subRollup = await this.costRollup(orgId, item.subBomId);
        if (subRollup.ok) {
          unitCost = Math.round((subRollup.value.totalCost ?? 0) / (subRollup.value.yieldQuantity ?? 1));
        }
      }

      const itemTotal = (item.quantity ?? 0) * unitCost;
      totalCost += itemTotal;

      // Update item costs
      await this.db.update(productionBomItems).set({
        unitCost,
        totalCost: itemTotal,
      }).where(eq(productionBomItems.id, item.id));
    }

    // Update BOM total
    const updated = await this.db.update(productionBoms).set({
      totalCost,
      updatedAt: new Date(),
    }).where(eq(productionBoms.id, id)).returning();

    return Ok(updated[0]!);
  }

  async explode(orgId: string, bomId: string, quantity: number): Promise<PluginResult<ExplodedItem[]>> {
    const boms = await this.db.select().from(productionBoms)
      .where(and(eq(productionBoms.id, bomId), eq(productionBoms.organizationId, orgId)));
    if (boms.length === 0) return Err("BOM not found");
    const bom = boms[0]!;

    const materialMap = new Map<string, ExplodedItem>();
    await this.explodeRecursive(orgId, bomId, quantity, bom.yieldQuantity ?? 1, materialMap);

    return Ok(Array.from(materialMap.values()));
  }

  private async explodeRecursive(
    orgId: string,
    bomId: string,
    quantity: number,
    yieldQuantity: number,
    materialMap: Map<string, ExplodedItem>,
  ): Promise<void> {
    const items = await this.db.select().from(productionBomItems)
      .where(eq(productionBomItems.bomId, bomId))
      .orderBy(productionBomItems.sortOrder);

    const multiplier = quantity / yieldQuantity;

    for (const item of items) {
      const requiredQty = Math.round((item.quantity ?? 0) * multiplier);

      if (item.isSubAssembly && item.subBomId) {
        // Recurse into sub-assembly
        const subBoms = await this.db.select().from(productionBoms)
          .where(and(eq(productionBoms.id, item.subBomId), eq(productionBoms.organizationId, orgId)));
        if (subBoms.length > 0) {
          const subBom = subBoms[0]!;
          await this.explodeRecursive(orgId, item.subBomId, requiredQty, subBom.yieldQuantity ?? 1, materialMap);
        }
      } else {
        // Raw material — accumulate
        const existing = materialMap.get(item.entityId);
        if (existing) {
          existing.totalQuantity += requiredQty;
          existing.totalCost += requiredQty * (item.unitCost ?? 0);
        } else {
          materialMap.set(item.entityId, {
            entityId: item.entityId,
            itemName: item.itemName,
            totalQuantity: requiredQty,
            unitCost: item.unitCost ?? 0,
            totalCost: requiredQty * (item.unitCost ?? 0),
          });
        }
      }
    }
  }
}
