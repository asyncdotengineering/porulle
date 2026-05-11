import { eq, and, desc } from "@porulle/core/drizzle";
import { returnRequests, vendorSubOrders } from "../schema.js";
import type { Db, ReturnStatus } from "../types.js";

export class ReturnService {
  constructor(private db: Db) {}

  async request(data: {
    subOrderId: string;
    customerId?: string;
    reason: string;
    description?: string;
    lineItems?: Array<{ entityId: string; quantity: number; reason?: string }>;
  }) {
    const [req] = await this.db.insert(returnRequests).values({
      subOrderId: data.subOrderId,
      customerId: data.customerId,
      reason: data.reason,
      description: data.description,
      lineItems: data.lineItems,
    }).returning();
    return req;
  }

  async getById(id: string) {
    const [req] = await this.db.select().from(returnRequests).where(eq(returnRequests.id, id));
    return req ?? null;
  }

  async list(filters?: { subOrderId?: string; status?: string }) {
    let query = this.db.select().from(returnRequests).$dynamic();
    const conditions = [];
    if (filters?.subOrderId) conditions.push(eq(returnRequests.subOrderId, filters.subOrderId));
    if (filters?.status) conditions.push(eq(returnRequests.status, filters.status));
    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
    }
    return query.orderBy(desc(returnRequests.requestedAt));
  }

  async listByVendor(vendorId: string) {
    const subOrders = await this.db.select().from(vendorSubOrders)
      .where(eq(vendorSubOrders.vendorId, vendorId));
    const subOrderIds = subOrders.map((s: { id: string }) => s.id);
    if (subOrderIds.length === 0) return [];

    const all = await this.db.select().from(returnRequests)
      .orderBy(desc(returnRequests.requestedAt));
    return all.filter((r: { subOrderId: string }) => subOrderIds.includes(r.subOrderId));
  }

  async vendorApprove(id: string, refundAmountCents?: number) {
    const [updated] = await this.db.update(returnRequests).set({
      status: "vendor_approved" as ReturnStatus,
      refundAmountCents,
    }).where(eq(returnRequests.id, id)).returning();
    return updated ?? null;
  }

  async vendorReject(id: string, notes?: string) {
    const [updated] = await this.db.update(returnRequests).set({
      status: "vendor_rejected" as ReturnStatus,
      vendorNotes: notes,
      resolvedAt: new Date(),
    }).where(eq(returnRequests.id, id)).returning();
    return updated ?? null;
  }

  async shipBack(id: string, trackingNumber: string) {
    const [updated] = await this.db.update(returnRequests).set({
      status: "shipped_back" as ReturnStatus,
      trackingNumber,
    }).where(eq(returnRequests.id, id)).returning();
    return updated ?? null;
  }

  async receive(id: string) {
    const [updated] = await this.db.update(returnRequests).set({
      status: "received" as ReturnStatus,
    }).where(eq(returnRequests.id, id)).returning();
    return updated ?? null;
  }

  async refund(id: string, amountCents: number) {
    const [updated] = await this.db.update(returnRequests).set({
      status: "refunded" as ReturnStatus,
      refundAmountCents: amountCents,
      resolvedAt: new Date(),
    }).where(eq(returnRequests.id, id)).returning();
    return updated ?? null;
  }
}
