import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { goodsReceivedNotes, grnItems, purchaseOrders, purchaseOrderItems } from "../schema.js";
import type { Db, GoodsReceivedNote, GRNItem } from "../types.js";

export class GRNService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    poId: string; supplierId: string; warehouseId: string; receivedBy: string; notes?: string;
    items: Array<{
      poItemId: string; entityId: string; variantId?: string;
      quantityOrdered: number; quantityReceived: number; quantityAccepted: number;
      quantityRejected?: number; rejectionReason?: string; batchNumber?: string;
      expiryDate?: string; unitCost: number;
    }>;
  }): Promise<PluginResult<GoodsReceivedNote>> {
    const poRows = await this.db.select().from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, input.poId), eq(purchaseOrders.organizationId, orgId)));
    if (poRows.length === 0) return Err("Purchase order not found");

    const poItemRows = await this.db.select().from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.poId, input.poId));
    const poItemIds = new Set(poItemRows.map((row) => row.id));
    for (const item of input.items) {
      if (!poItemIds.has(item.poItemId)) {
        return Err("Purchase order item not found");
      }
    }

    const grnNumber = await this.generateGRNNumber(orgId);

    const rows = await this.db.insert(goodsReceivedNotes).values({
      organizationId: orgId, grnNumber, poId: input.poId, supplierId: input.supplierId,
      warehouseId: input.warehouseId, receivedBy: input.receivedBy, notes: input.notes,
    }).returning();
    const grn = rows[0]!;

    for (const item of input.items) {
      await this.db.insert(grnItems).values({
        grnId: grn.id, poItemId: item.poItemId, entityId: item.entityId,
        variantId: item.variantId, quantityOrdered: item.quantityOrdered,
        quantityReceived: item.quantityReceived, quantityAccepted: item.quantityAccepted,
        quantityRejected: item.quantityRejected ?? 0, rejectionReason: item.rejectionReason,
        batchNumber: item.batchNumber,
        ...(item.expiryDate ? { expiryDate: new Date(item.expiryDate) } : {}),
        unitCost: item.unitCost,
      });

      // Update PO item received quantity
      await this.db.update(purchaseOrderItems).set({
        quantityReceived: sql`${purchaseOrderItems.quantityReceived} + ${item.quantityReceived}`,
      }).where(eq(purchaseOrderItems.id, item.poItemId));
    }

    // Check if PO is fully received
    const poItems = await this.db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, input.poId));
    const allReceived = poItems.every(pi => pi.quantityReceived >= pi.quantityOrdered);
    const someReceived = poItems.some(pi => pi.quantityReceived > 0);

    if (allReceived) {
      await this.db.update(purchaseOrders).set({ status: "received", updatedAt: new Date() })
        .where(eq(purchaseOrders.id, input.poId));
    } else if (someReceived) {
      await this.db.update(purchaseOrders).set({ status: "partially_received", updatedAt: new Date() })
        .where(eq(purchaseOrders.id, input.poId));
    }

    return Ok(grn);
  }

  async list(orgId: string): Promise<PluginResult<GoodsReceivedNote[]>> {
    const rows = await this.db.select().from(goodsReceivedNotes).where(eq(goodsReceivedNotes.organizationId, orgId));
    return Ok(rows);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<{ grn: GoodsReceivedNote; items: GRNItem[] }>> {
    const rows = await this.db.select().from(goodsReceivedNotes)
      .where(and(eq(goodsReceivedNotes.id, id), eq(goodsReceivedNotes.organizationId, orgId)));
    if (rows.length === 0) return Err("GRN not found");
    const items = await this.db.select().from(grnItems).where(eq(grnItems.grnId, id));
    return Ok({ grn: rows[0]!, items });
  }

  async accept(orgId: string, id: string): Promise<PluginResult<GoodsReceivedNote>> {
    const items = await this.db.select().from(grnItems)
      .where(eq(grnItems.grnId, id));
    const hasDiscrepancy = items.some(i => i.quantityRejected > 0);
    const newStatus = hasDiscrepancy ? "accepted_with_discrepancy" : "accepted";

    const rows = await this.db.update(goodsReceivedNotes).set({ status: newStatus })
      .where(and(eq(goodsReceivedNotes.id, id), eq(goodsReceivedNotes.organizationId, orgId))).returning();
    if (rows.length === 0) return Err("GRN not found");
    return Ok(rows[0]!);
  }

  private async generateGRNNumber(orgId: string): Promise<string> {
    const countRows = await this.db.select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(goodsReceivedNotes).where(eq(goodsReceivedNotes.organizationId, orgId));
    const seq = Number(countRows[0]?.count ?? 0) + 1;
    return `GRN-${String(seq).padStart(4, "0")}`;
  }
}
