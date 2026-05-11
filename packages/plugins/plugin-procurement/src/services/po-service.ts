import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { purchaseOrders, purchaseOrderItems } from "../schema.js";
import type { Db, PurchaseOrder, PurchaseOrderItem } from "../types.js";

export class PurchaseOrderService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    supplierId: string; warehouseId: string; requestedBy: string;
    expectedDelivery?: string; notes?: string;
    items: Array<{ entityId: string; variantId?: string; itemName: string; quantityOrdered: number; unitCost: number }>;
  }): Promise<PluginResult<PurchaseOrder>> {
    const poNumber = await this.generatePONumber(orgId);
    let subtotal = 0;
    for (const item of input.items) subtotal += item.quantityOrdered * item.unitCost;

    const rows = await this.db.insert(purchaseOrders).values({
      organizationId: orgId, poNumber, supplierId: input.supplierId,
      warehouseId: input.warehouseId, requestedBy: input.requestedBy,
      ...(input.expectedDelivery ? { expectedDelivery: new Date(input.expectedDelivery) } : {}),
      subtotal, grandTotal: subtotal, notes: input.notes,
    }).returning();
    const po = rows[0]!;

    for (const item of input.items) {
      await this.db.insert(purchaseOrderItems).values({
        poId: po.id, entityId: item.entityId, variantId: item.variantId,
        itemName: item.itemName, quantityOrdered: item.quantityOrdered,
        unitCost: item.unitCost, totalCost: item.quantityOrdered * item.unitCost,
      });
    }
    return Ok(po);
  }

  async list(orgId: string, status?: string): Promise<PluginResult<PurchaseOrder[]>> {
    const conditions = [eq(purchaseOrders.organizationId, orgId)];
    if (status) conditions.push(eq(purchaseOrders.status, status as PurchaseOrder["status"]));
    const rows = await this.db.select().from(purchaseOrders).where(and(...conditions));
    return Ok(rows);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<{ po: PurchaseOrder; items: PurchaseOrderItem[] }>> {
    const rows = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.organizationId, orgId)));
    if (rows.length === 0) return Err("Purchase order not found");
    const items = await this.db.select().from(purchaseOrderItems).where(eq(purchaseOrderItems.poId, id));
    return Ok({ po: rows[0]!, items });
  }

  async submit(orgId: string, id: string): Promise<PluginResult<PurchaseOrder>> {
    return this.transition(orgId, id, "draft", "pending_approval");
  }

  async approve(orgId: string, id: string, approvedBy: string): Promise<PluginResult<PurchaseOrder>> {
    const rows = await this.db.update(purchaseOrders).set({
      status: "approved", approvedBy, approvedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.organizationId, orgId), eq(purchaseOrders.status, "pending_approval")))
      .returning();
    if (rows.length === 0) return Err("PO not found or not in pending_approval status");
    return Ok(rows[0]!);
  }

  async cancel(orgId: string, id: string): Promise<PluginResult<PurchaseOrder>> {
    const rows = await this.db.update(purchaseOrders).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.organizationId, orgId))).returning();
    if (rows.length === 0) return Err("PO not found");
    return Ok(rows[0]!);
  }

  private async transition(orgId: string, id: string, from: string, to: string): Promise<PluginResult<PurchaseOrder>> {
    const rows = await this.db.update(purchaseOrders).set({ status: to as PurchaseOrder["status"], updatedAt: new Date() })
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.organizationId, orgId), eq(purchaseOrders.status, from as PurchaseOrder["status"])))
      .returning();
    if (rows.length === 0) return Err(`PO not found or not in '${from}' status`);
    return Ok(rows[0]!);
  }

  private async generatePONumber(orgId: string): Promise<string> {
    const countRows = await this.db.select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(purchaseOrders).where(eq(purchaseOrders.organizationId, orgId));
    const seq = Number(countRows[0]?.count ?? 0) + 1;
    return `PO-${String(seq).padStart(4, "0")}`;
  }
}
