import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { stockReconciliations, reconciliationItems } from "../schema.js";
import type { Db, StockReconciliation, ReconciliationItem } from "../types.js";

export class ReconciliationService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    warehouseId: string; countedBy: string;
    items: Array<{ entityId: string; variantId?: string; itemName: string; systemQuantity: number; physicalQuantity: number; notes?: string }>;
  }): Promise<PluginResult<StockReconciliation>> {
    const recNumber = await this.generateNumber(orgId);
    const rows = await this.db.insert(stockReconciliations).values({
      organizationId: orgId, reconciliationNumber: recNumber,
      warehouseId: input.warehouseId, countedBy: input.countedBy, countedAt: new Date(),
    }).returning();
    const rec = rows[0]!;

    for (const item of input.items) {
      const variance = item.physicalQuantity - item.systemQuantity;
      await this.db.insert(reconciliationItems).values({
        reconciliationId: rec.id, entityId: item.entityId, variantId: item.variantId,
        itemName: item.itemName, systemQuantity: item.systemQuantity,
        physicalQuantity: item.physicalQuantity, variance, notes: item.notes,
      });
    }
    return Ok(rec);
  }

  async list(orgId: string): Promise<PluginResult<StockReconciliation[]>> {
    return Ok(await this.db.select().from(stockReconciliations).where(eq(stockReconciliations.organizationId, orgId)));
  }

  async getById(orgId: string, id: string): Promise<PluginResult<{ reconciliation: StockReconciliation; items: ReconciliationItem[] }>> {
    const rows = await this.db.select().from(stockReconciliations)
      .where(and(eq(stockReconciliations.id, id), eq(stockReconciliations.organizationId, orgId)));
    if (rows.length === 0) return Err("Reconciliation not found");
    const items = await this.db.select().from(reconciliationItems).where(eq(reconciliationItems.reconciliationId, id));
    return Ok({ reconciliation: rows[0]!, items });
  }

  async submit(orgId: string, id: string): Promise<PluginResult<StockReconciliation>> {
    const rows = await this.db.update(stockReconciliations).set({ status: "submitted" })
      .where(and(eq(stockReconciliations.id, id), eq(stockReconciliations.organizationId, orgId), eq(stockReconciliations.status, "draft"))).returning();
    if (rows.length === 0) return Err("Not found or not in draft status");
    return Ok(rows[0]!);
  }

  async approve(orgId: string, id: string, approvedBy: string): Promise<PluginResult<StockReconciliation>> {
    // Mark items with variance as adjusted
    const items = await this.db.select().from(reconciliationItems).where(eq(reconciliationItems.reconciliationId, id));
    for (const item of items) {
      if (item.variance !== 0) {
        await this.db.update(reconciliationItems).set({ adjustmentMade: true }).where(eq(reconciliationItems.id, item.id));
      }
    }
    const rows = await this.db.update(stockReconciliations).set({ status: "approved", approvedBy })
      .where(and(eq(stockReconciliations.id, id), eq(stockReconciliations.organizationId, orgId), eq(stockReconciliations.status, "submitted"))).returning();
    if (rows.length === 0) return Err("Not found or not in submitted status");
    return Ok(rows[0]!);
  }

  private async generateNumber(orgId: string): Promise<string> {
    const countRows = await this.db.select({ count: sql<number>`COUNT(*)`.as("count") }).from(stockReconciliations).where(eq(stockReconciliations.organizationId, orgId));
    return `REC-${String(Number(countRows[0]?.count ?? 0) + 1).padStart(4, "0")}`;
  }
}
