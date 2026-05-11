import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { stockTransfers, stockTransferItems } from "../schema.js";
import type { Db, StockTransfer, StockTransferItem } from "../types.js";

export class TransferService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    fromWarehouseId: string; toWarehouseId: string; requestedBy: string;
    type?: "requisition" | "direct" | "return"; notes?: string;
    items: Array<{ entityId: string; variantId?: string; itemName: string; quantityRequested: number; batchNumber?: string }>;
  }): Promise<PluginResult<StockTransfer>> {
    if (input.fromWarehouseId === input.toWarehouseId) return Err("Cannot transfer to the same warehouse");
    const transferNumber = await this.generateNumber(orgId, "TRF");
    const rows = await this.db.insert(stockTransfers).values({
      organizationId: orgId, transferNumber, type: input.type ?? "requisition",
      fromWarehouseId: input.fromWarehouseId, toWarehouseId: input.toWarehouseId,
      requestedBy: input.requestedBy, notes: input.notes,
    }).returning();
    const transfer = rows[0]!;
    for (const item of input.items) {
      await this.db.insert(stockTransferItems).values({ transferId: transfer.id, ...item });
    }
    return Ok(transfer);
  }

  async list(orgId: string, status?: string): Promise<PluginResult<StockTransfer[]>> {
    const conditions = [eq(stockTransfers.organizationId, orgId)];
    if (status) conditions.push(eq(stockTransfers.status, status as StockTransfer["status"]));
    return Ok(await this.db.select().from(stockTransfers).where(and(...conditions)));
  }

  async getById(orgId: string, id: string): Promise<PluginResult<{ transfer: StockTransfer; items: StockTransferItem[] }>> {
    const rows = await this.db.select().from(stockTransfers).where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, orgId)));
    if (rows.length === 0) return Err("Transfer not found");
    const items = await this.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, id));
    return Ok({ transfer: rows[0]!, items });
  }

  async approve(orgId: string, id: string, approvedBy: string): Promise<PluginResult<StockTransfer>> {
    const rows = await this.db.update(stockTransfers).set({ status: "approved", approvedBy, updatedAt: new Date() })
      .where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, orgId), eq(stockTransfers.status, "draft"))).returning();
    if (rows.length === 0) return Err("Transfer not found or not in draft status");
    return Ok(rows[0]!);
  }

  async dispatch(orgId: string, id: string): Promise<PluginResult<StockTransfer>> {
    const items = await this.db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, id));
    for (const item of items) {
      await this.db.update(stockTransferItems).set({ quantityDispatched: item.quantityRequested }).where(eq(stockTransferItems.id, item.id));
    }
    const rows = await this.db.update(stockTransfers).set({ status: "in_transit", dispatchedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, orgId), eq(stockTransfers.status, "approved"))).returning();
    if (rows.length === 0) return Err("Transfer not found or not in approved status");
    return Ok(rows[0]!);
  }

  async receive(orgId: string, id: string, receivedItems: Array<{ itemId: string; quantityReceived: number }>): Promise<PluginResult<StockTransfer>> {
    for (const ri of receivedItems) {
      await this.db.update(stockTransferItems).set({ quantityReceived: ri.quantityReceived }).where(eq(stockTransferItems.id, ri.itemId));
    }
    const rows = await this.db.update(stockTransfers).set({ status: "received", receivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(stockTransfers.id, id), eq(stockTransfers.organizationId, orgId), eq(stockTransfers.status, "in_transit"))).returning();
    if (rows.length === 0) return Err("Transfer not found or not in transit");
    return Ok(rows[0]!);
  }

  private async generateNumber(orgId: string, prefix: string): Promise<string> {
    const countRows = await this.db.select({ count: sql<number>`COUNT(*)`.as("count") }).from(stockTransfers).where(eq(stockTransfers.organizationId, orgId));
    return `${prefix}-${String(Number(countRows[0]?.count ?? 0) + 1).padStart(4, "0")}`;
  }
}
