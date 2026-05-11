import { eq, and, desc } from "@porulle/core/drizzle";
import { vendorSubOrders } from "../schema.js";
import type { Db, SubOrderStatus } from "../types.js";
import { SUB_ORDER_TRANSITIONS } from "../types.js";

export interface SubOrderCancelCallback {
  (subOrder: { id: string; orderId: string; vendorId: string; payoutAmount: number; lineItems: unknown }): Promise<void>;
}

export class SubOrderService {
  private onCancel?: SubOrderCancelCallback | undefined;

  constructor(private db: Db, onCancel?: SubOrderCancelCallback) {
    this.onCancel = onCancel;
  }

  async getById(id: string) {
    const [sub] = await this.db.select().from(vendorSubOrders).where(eq(vendorSubOrders.id, id));
    return sub ?? null;
  }

  async listByOrder(orderId: string) {
    return this.db.select().from(vendorSubOrders)
      .where(eq(vendorSubOrders.orderId, orderId))
      .orderBy(desc(vendorSubOrders.createdAt));
  }

  async listByVendor(vendorId: string, filters?: { status?: string }) {
    const conditions = [eq(vendorSubOrders.vendorId, vendorId)];
    if (filters?.status) conditions.push(eq(vendorSubOrders.status, filters.status));

    return this.db.select().from(vendorSubOrders)
      .where(conditions.length === 1 ? conditions[0]! : and(...conditions))
      .orderBy(desc(vendorSubOrders.createdAt));
  }

  async list(filters?: { orderId?: string; vendorId?: string; status?: string }) {
    let query = this.db.select().from(vendorSubOrders).$dynamic();
    const conditions = [];
    if (filters?.orderId) conditions.push(eq(vendorSubOrders.orderId, filters.orderId));
    if (filters?.vendorId) conditions.push(eq(vendorSubOrders.vendorId, filters.vendorId));
    if (filters?.status) conditions.push(eq(vendorSubOrders.status, filters.status));
    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
    }
    return query.orderBy(desc(vendorSubOrders.createdAt));
  }

  private assertTransition(current: SubOrderStatus, next: SubOrderStatus) {
    const allowed = SUB_ORDER_TRANSITIONS[current];
    if (!allowed?.includes(next)) {
      throw new Error(`Cannot transition sub-order from "${current}" to "${next}".`);
    }
  }

  async confirm(id: string) {
    const sub = await this.getById(id);
    if (!sub) throw new Error("Sub-order not found.");
    this.assertTransition(sub.status as SubOrderStatus, "confirmed");

    const [updated] = await this.db.update(vendorSubOrders).set({
      status: "confirmed",
      confirmedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(vendorSubOrders.id, id)).returning();
    return updated;
  }

  async process(id: string) {
    const sub = await this.getById(id);
    if (!sub) throw new Error("Sub-order not found.");
    this.assertTransition(sub.status as SubOrderStatus, "processing");

    const [updated] = await this.db.update(vendorSubOrders).set({
      status: "processing",
      updatedAt: new Date(),
    }).where(eq(vendorSubOrders.id, id)).returning();
    return updated;
  }

  async ship(id: string, data: { trackingNumber: string; carrier: string }) {
    const sub = await this.getById(id);
    if (!sub) throw new Error("Sub-order not found.");
    this.assertTransition(sub.status as SubOrderStatus, "shipped");

    const [updated] = await this.db.update(vendorSubOrders).set({
      status: "shipped",
      trackingNumber: data.trackingNumber,
      carrier: data.carrier,
      shippedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(vendorSubOrders.id, id)).returning();
    return updated;
  }

  async deliver(id: string) {
    const sub = await this.getById(id);
    if (!sub) throw new Error("Sub-order not found.");
    this.assertTransition(sub.status as SubOrderStatus, "delivered");

    const [updated] = await this.db.update(vendorSubOrders).set({
      status: "delivered",
      deliveredAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(vendorSubOrders.id, id)).returning();
    return updated;
  }

  async cancel(id: string, reason?: string) {
    const sub = await this.getById(id);
    if (!sub) throw new Error("Sub-order not found.");
    this.assertTransition(sub.status as SubOrderStatus, "cancelled");

    const [updated] = await this.db.update(vendorSubOrders).set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancellationReason: reason,
      updatedAt: new Date(),
    }).where(eq(vendorSubOrders.id, id)).returning();

    // Trigger side effects: release inventory + reverse ledger
    if (this.onCancel && sub) {
      await this.onCancel(sub);
    }

    return updated;
  }

  async forceStatus(id: string, status: SubOrderStatus) {
    const [updated] = await this.db.update(vendorSubOrders).set({
      status,
      updatedAt: new Date(),
    }).where(eq(vendorSubOrders.id, id)).returning();
    return updated ?? null;
  }
}
