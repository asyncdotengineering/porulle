import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { productionBoms, productionBomItems, productionOrders, productionConsumption } from "../schema.js";
import type { Db, ProductionOrder, Consumption } from "../types.js";

export class ProductionOrderService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    bomId: string;
    entityId: string;
    quantity: number;
    warehouseId: string;
    plannedDate: Date;
    notes?: string;
  }): Promise<PluginResult<ProductionOrder>> {
    // Verify BOM exists
    const boms = await this.db.select().from(productionBoms)
      .where(and(eq(productionBoms.id, input.bomId), eq(productionBoms.organizationId, orgId)));
    if (boms.length === 0) return Err("BOM not found");

    const orderNumber = await this.generateOrderNumber(orgId);
    const rows = await this.db.insert(productionOrders).values({
      organizationId: orgId,
      orderNumber,
      bomId: input.bomId,
      entityId: input.entityId,
      quantity: input.quantity,
      warehouseId: input.warehouseId,
      plannedDate: input.plannedDate,
      notes: input.notes,
    }).returning();

    return Ok(rows[0]!);
  }

  async list(orgId: string, status?: string): Promise<PluginResult<ProductionOrder[]>> {
    const conditions = [eq(productionOrders.organizationId, orgId)];
    if (status) {
      conditions.push(eq(productionOrders.status, status as "planned" | "in_progress" | "completed" | "cancelled"));
    }
    const rows = await this.db.select().from(productionOrders).where(and(...conditions));
    return Ok(rows);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<ProductionOrder & { consumption: Consumption[] }>> {
    const orders = await this.db.select().from(productionOrders)
      .where(and(eq(productionOrders.id, id), eq(productionOrders.organizationId, orgId)));
    if (orders.length === 0) return Err("Order not found");
    const order = orders[0]!;

    const consumption = await this.db.select().from(productionConsumption)
      .where(eq(productionConsumption.productionOrderId, id));

    return Ok({ ...order, consumption });
  }

  async start(orgId: string, id: string, producedBy: string): Promise<PluginResult<ProductionOrder>> {
    const orders = await this.db.select().from(productionOrders)
      .where(and(eq(productionOrders.id, id), eq(productionOrders.organizationId, orgId)));
    if (orders.length === 0) return Err("Order not found");
    const order = orders[0]!;
    if (order.status !== "planned") return Err(`Cannot start order in '${order.status}' status`);

    const rows = await this.db.update(productionOrders).set({
      status: "in_progress",
      producedBy,
      startedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(productionOrders.id, id)).returning();

    return Ok(rows[0]!);
  }

  async recordConsumption(orgId: string, orderId: string, items: Array<{
    entityId: string;
    variantId?: string;
    plannedQuantity: number;
    actualQuantity: number;
    uomId?: string;
    unitCost: number;
    batchNumber?: string;
  }>): Promise<PluginResult<Consumption[]>> {
    // Verify order exists and is in_progress
    const orders = await this.db.select().from(productionOrders)
      .where(and(eq(productionOrders.id, orderId), eq(productionOrders.organizationId, orgId)));
    if (orders.length === 0) return Err("Order not found");
    const order = orders[0]!;
    if (order.status !== "in_progress") return Err(`Cannot record consumption for order in '${order.status}' status`);

    const insertedItems: Consumption[] = [];
    for (const item of items) {
      const totalCost = item.actualQuantity * item.unitCost;
      const rows = await this.db.insert(productionConsumption).values({
        productionOrderId: orderId,
        entityId: item.entityId,
        variantId: item.variantId,
        plannedQuantity: item.plannedQuantity,
        actualQuantity: item.actualQuantity,
        uomId: item.uomId,
        unitCost: item.unitCost,
        totalCost,
        batchNumber: item.batchNumber,
      }).returning();
      insertedItems.push(rows[0]!);
    }

    return Ok(insertedItems);
  }

  async complete(orgId: string, id: string): Promise<PluginResult<ProductionOrder & { consumption: Consumption[] }>> {
    const orders = await this.db.select().from(productionOrders)
      .where(and(eq(productionOrders.id, id), eq(productionOrders.organizationId, orgId)));
    if (orders.length === 0) return Err("Order not found");
    const order = orders[0]!;
    if (order.status !== "in_progress") return Err(`Cannot complete order in '${order.status}' status`);

    // If no consumption records yet, auto-generate from BOM explosion
    const existingConsumption = await this.db.select().from(productionConsumption)
      .where(eq(productionConsumption.productionOrderId, id));

    if (existingConsumption.length === 0) {
      // Auto-consume based on BOM items
      const bomItems = await this.db.select().from(productionBomItems)
        .where(eq(productionBomItems.bomId, order.bomId));

      const boms = await this.db.select().from(productionBoms)
        .where(eq(productionBoms.id, order.bomId));
      const yieldQty = boms.length > 0 ? (boms[0]!.yieldQuantity ?? 1) : 1;
      const multiplier = order.quantity / yieldQty;

      for (const bomItem of bomItems) {
        if (bomItem.isSubAssembly) continue; // Skip sub-assemblies for auto-consumption
        const plannedQty = Math.round((bomItem.quantity ?? 0) * multiplier);
        const unitCost = bomItem.unitCost ?? 0;
        await this.db.insert(productionConsumption).values({
          productionOrderId: id,
          entityId: bomItem.entityId,
          plannedQuantity: plannedQty,
          actualQuantity: plannedQty,
          unitCost,
          totalCost: plannedQty * unitCost,
        });
      }
    }

    const rows = await this.db.update(productionOrders).set({
      status: "completed",
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(productionOrders.id, id)).returning();

    const consumption = await this.db.select().from(productionConsumption)
      .where(eq(productionConsumption.productionOrderId, id));

    return Ok({ ...rows[0]!, consumption });
  }

  async cancel(orgId: string, id: string): Promise<PluginResult<ProductionOrder>> {
    const orders = await this.db.select().from(productionOrders)
      .where(and(eq(productionOrders.id, id), eq(productionOrders.organizationId, orgId)));
    if (orders.length === 0) return Err("Order not found");
    const order = orders[0]!;
    if (order.status === "completed") return Err("Cannot cancel a completed order");
    if (order.status === "cancelled") return Err("Order is already cancelled");

    const rows = await this.db.update(productionOrders).set({
      status: "cancelled",
      updatedAt: new Date(),
    }).where(eq(productionOrders.id, id)).returning();

    return Ok(rows[0]!);
  }

  private async generateOrderNumber(orgId: string): Promise<string> {
    const countRows = await this.db.select({ count: sql<number>`COUNT(*)`.as("count") })
      .from(productionOrders).where(eq(productionOrders.organizationId, orgId));
    const seq = Number(countRows[0]?.count ?? 0) + 1;
    return `PRD-${String(seq).padStart(4, "0")}`;
  }
}
