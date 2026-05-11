import { eq, and } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { unitsOfMeasure, uomConversions, entityUom } from "../schema.js";
import type { Db, UnitOfMeasure, UOMConversion, EntityUOM, UOMCategory } from "../types.js";

export class UOMService {
  constructor(private db: Db) {}

  async createUnit(orgId: string, input: {
    code: string; name: string; category: UOMCategory; isBaseUnit?: boolean;
  }): Promise<PluginResult<UnitOfMeasure>> {
    const existing = await this.db.select().from(unitsOfMeasure)
      .where(and(eq(unitsOfMeasure.organizationId, orgId), eq(unitsOfMeasure.code, input.code)));
    if (existing.length > 0) return Err(`Unit '${input.code}' already exists`);
    const rows = await this.db.insert(unitsOfMeasure).values({
      organizationId: orgId, code: input.code, name: input.name,
      category: input.category, isBaseUnit: input.isBaseUnit ?? false,
    }).returning();
    return Ok(rows[0]!);
  }

  async listUnits(orgId: string, category?: UOMCategory): Promise<PluginResult<UnitOfMeasure[]>> {
    const conditions = [eq(unitsOfMeasure.organizationId, orgId)];
    if (category) conditions.push(eq(unitsOfMeasure.category, category));
    const rows = await this.db.select().from(unitsOfMeasure).where(and(...conditions));
    return Ok(rows);
  }

  async createConversion(orgId: string, input: {
    fromUnitId: string; toUnitId: string; factor: number;
  }): Promise<PluginResult<UOMConversion>> {
    if (input.factor <= 0) return Err("Factor must be positive");
    const rows = await this.db.insert(uomConversions).values({
      organizationId: orgId, fromUnitId: input.fromUnitId,
      toUnitId: input.toUnitId, factor: input.factor,
    }).returning();
    return Ok(rows[0]!);
  }

  async listConversions(orgId: string): Promise<PluginResult<UOMConversion[]>> {
    const rows = await this.db.select().from(uomConversions)
      .where(eq(uomConversions.organizationId, orgId));
    return Ok(rows);
  }

  async convert(orgId: string, input: {
    fromUnitId: string; toUnitId: string; quantity: number;
  }): Promise<PluginResult<{ result: number; fromCode: string; toCode: string }>> {
    if (input.fromUnitId === input.toUnitId) {
      const unit = await this.db.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.id, input.fromUnitId));
      return Ok({ result: input.quantity, fromCode: unit[0]?.code ?? "", toCode: unit[0]?.code ?? "" });
    }
    // Try forward conversion
    const forward = await this.db.select().from(uomConversions).where(and(
      eq(uomConversions.organizationId, orgId),
      eq(uomConversions.fromUnitId, input.fromUnitId),
      eq(uomConversions.toUnitId, input.toUnitId),
    ));
    const fromUnit = await this.db.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.id, input.fromUnitId));
    const toUnit = await this.db.select().from(unitsOfMeasure).where(eq(unitsOfMeasure.id, input.toUnitId));
    const fromCode = fromUnit[0]?.code ?? "";
    const toCode = toUnit[0]?.code ?? "";

    if (forward.length > 0) {
      return Ok({ result: Math.round(input.quantity * forward[0]!.factor / 10000), fromCode, toCode });
    }
    // Try reverse
    const reverse = await this.db.select().from(uomConversions).where(and(
      eq(uomConversions.organizationId, orgId),
      eq(uomConversions.fromUnitId, input.toUnitId),
      eq(uomConversions.toUnitId, input.fromUnitId),
    ));
    if (reverse.length > 0) {
      return Ok({ result: Math.round(input.quantity * 10000 / reverse[0]!.factor), fromCode, toCode });
    }
    return Err(`No conversion found between '${fromCode}' and '${toCode}'`);
  }

  async setEntityUom(orgId: string, input: {
    entityId: string; purchaseUomId: string; stockUomId: string; saleUomId: string; yieldPercentage?: number;
  }): Promise<PluginResult<EntityUOM>> {
    const existing = await this.db.select().from(entityUom)
      .where(and(eq(entityUom.organizationId, orgId), eq(entityUom.entityId, input.entityId)));
    if (existing.length > 0) {
      const rows = await this.db.update(entityUom).set({
        purchaseUomId: input.purchaseUomId, stockUomId: input.stockUomId,
        saleUomId: input.saleUomId, yieldPercentage: input.yieldPercentage ?? 100, updatedAt: new Date(),
      }).where(eq(entityUom.id, existing[0]!.id)).returning();
      return Ok(rows[0]!);
    }
    const rows = await this.db.insert(entityUom).values({
      organizationId: orgId, entityId: input.entityId,
      purchaseUomId: input.purchaseUomId, stockUomId: input.stockUomId,
      saleUomId: input.saleUomId, yieldPercentage: input.yieldPercentage ?? 100,
    }).returning();
    return Ok(rows[0]!);
  }

  async getEntityUom(orgId: string, entityId: string): Promise<PluginResult<EntityUOM>> {
    const rows = await this.db.select().from(entityUom)
      .where(and(eq(entityUom.organizationId, orgId), eq(entityUom.entityId, entityId)));
    if (rows.length === 0) return Err("No UOM assignment for this entity");
    return Ok(rows[0]!);
  }

  async calculateYield(yieldPercentage: number, requiredQuantity: number): Promise<PluginResult<{ purchaseQuantity: number }>> {
    if (yieldPercentage <= 0 || yieldPercentage > 100) return Ok({ purchaseQuantity: requiredQuantity });
    return Ok({ purchaseQuantity: Math.ceil(requiredQuantity * 100 / yieldPercentage) });
  }
}
