import { eq, and, lte, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import { scheduledOrders } from "../schema.js";
import type { Db, ScheduledOrder, ScheduledOrderStatus, ScheduledOrderType } from "../types.js";

export class ScheduledOrderService {
  constructor(private db: Db) {}

  async create(orgId: string, input: {
    customerId: string;
    cartId: string;
    scheduledFor: string;
    orderType?: ScheduledOrderType;
    pickupLocation?: string;
    deliveryAddress?: unknown;
    notes?: string;
  }): Promise<PluginResult<ScheduledOrder>> {
    const rows = await this.db.insert(scheduledOrders).values({
      organizationId: orgId,
      customerId: input.customerId,
      cartId: input.cartId,
      scheduledFor: new Date(input.scheduledFor),
      orderType: input.orderType ?? "pickup",
      pickupLocation: input.pickupLocation,
      deliveryAddress: input.deliveryAddress,
      notes: input.notes,
    }).returning();
    return Ok(rows[0]!);
  }

  async list(orgId: string, status?: ScheduledOrderStatus): Promise<PluginResult<ScheduledOrder[]>> {
    const conditions = [eq(scheduledOrders.organizationId, orgId)];
    if (status) conditions.push(eq(scheduledOrders.status, status));
    const rows = await this.db.select().from(scheduledOrders).where(and(...conditions));
    return Ok(rows);
  }

  async getById(orgId: string, id: string): Promise<PluginResult<ScheduledOrder>> {
    const rows = await this.db.select().from(scheduledOrders)
      .where(and(eq(scheduledOrders.organizationId, orgId), eq(scheduledOrders.id, id)));
    if (rows.length === 0) return Err("Scheduled order not found");
    return Ok(rows[0]!);
  }

  async cancel(orgId: string, id: string): Promise<PluginResult<ScheduledOrder>> {
    const existing = await this.db.select().from(scheduledOrders)
      .where(and(eq(scheduledOrders.organizationId, orgId), eq(scheduledOrders.id, id)));
    if (existing.length === 0) return Err("Scheduled order not found");
    if (existing[0]!.status !== "scheduled") return Err(`Cannot cancel order with status '${existing[0]!.status}'`);
    const rows = await this.db.update(scheduledOrders).set({
      status: "cancelled",
      updatedAt: new Date(),
    }).where(eq(scheduledOrders.id, id)).returning();
    return Ok(rows[0]!);
  }

  async processDue(orgId: string, bufferMinutes: number = 15): Promise<PluginResult<ScheduledOrder[]>> {
    const cutoff = new Date(Date.now() + bufferMinutes * 60 * 1000).toISOString();
    const due = await this.db.select().from(scheduledOrders)
      .where(and(
        eq(scheduledOrders.organizationId, orgId),
        eq(scheduledOrders.status, "scheduled"),
        lte(scheduledOrders.scheduledFor, sql`${cutoff}::timestamptz`),
      ));
    if (due.length === 0) return Ok([]);
    const ids = due.map(d => d.id);
    const updated: ScheduledOrder[] = [];
    for (const dueId of ids) {
      const rows = await this.db.update(scheduledOrders).set({
        status: "processing",
        processedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(scheduledOrders.id, dueId)).returning();
      updated.push(rows[0]!);
    }
    return Ok(updated);
  }

  async complete(orgId: string, id: string): Promise<PluginResult<ScheduledOrder>> {
    const existing = await this.db.select().from(scheduledOrders)
      .where(and(eq(scheduledOrders.organizationId, orgId), eq(scheduledOrders.id, id)));
    if (existing.length === 0) return Err("Scheduled order not found");
    const rows = await this.db.update(scheduledOrders).set({
      status: "completed",
      updatedAt: new Date(),
    }).where(eq(scheduledOrders.id, id)).returning();
    return Ok(rows[0]!);
  }

  async expireOld(orgId: string, hoursThreshold: number = 24): Promise<PluginResult<ScheduledOrder[]>> {
    const cutoff = new Date(Date.now() - hoursThreshold * 60 * 60 * 1000).toISOString();
    const old = await this.db.select().from(scheduledOrders)
      .where(and(
        eq(scheduledOrders.organizationId, orgId),
        eq(scheduledOrders.status, "scheduled"),
        lte(scheduledOrders.scheduledFor, sql`${cutoff}::timestamptz`),
      ));
    if (old.length === 0) return Ok([]);
    const updated: ScheduledOrder[] = [];
    for (const item of old) {
      const rows = await this.db.update(scheduledOrders).set({
        status: "expired",
        updatedAt: new Date(),
      }).where(eq(scheduledOrders.id, item.id)).returning();
      updated.push(rows[0]!);
    }
    return Ok(updated);
  }
}
