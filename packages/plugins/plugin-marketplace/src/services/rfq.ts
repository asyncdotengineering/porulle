import { eq, and, desc } from "@porulle/core/drizzle";
import { rfqs, rfqResponses } from "../schema.js";
import type { Db, RFQStatus, RFQResponseStatus } from "../types.js";

export class RFQService {
  constructor(private db: Db) {}

  async create(data: {
    buyerId?: string;
    title: string;
    description?: string;
    categorySlug?: string;
    quantity?: number;
    budgetCents?: number;
    currency?: string;
    deadlineAt?: Date | undefined;
    metadata?: Record<string, unknown>;
  }) {
    const [rfq] = await this.db.insert(rfqs).values(data).returning();
    return rfq;
  }

  async getById(id: string) {
    const [rfq] = await this.db.select().from(rfqs).where(eq(rfqs.id, id));
    return rfq ?? null;
  }

  async list(filters?: { status?: string; categorySlug?: string }) {
    let query = this.db.select().from(rfqs).$dynamic();
    const conditions = [];
    if (filters?.status) conditions.push(eq(rfqs.status, filters.status));
    if (filters?.categorySlug) conditions.push(eq(rfqs.categorySlug, filters.categorySlug));
    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
    }
    return query.orderBy(desc(rfqs.createdAt));
  }

  async respond(rfqId: string, data: {
    vendorId: string;
    unitPriceCents: number;
    totalPriceCents: number;
    leadTimeDays?: number;
    notes?: string;
  }) {
    const [response] = await this.db.insert(rfqResponses).values({
      rfqId,
      ...data,
    }).returning();
    return response;
  }

  async getResponses(rfqId: string) {
    return this.db.select().from(rfqResponses)
      .where(eq(rfqResponses.rfqId, rfqId))
      .orderBy(desc(rfqResponses.createdAt));
  }

  async award(rfqId: string, vendorId: string) {
    // Mark RFQ as awarded
    const [updated] = await this.db.update(rfqs).set({
      status: "awarded" as RFQStatus,
      awardedVendorId: vendorId,
    }).where(eq(rfqs.id, rfqId)).returning();

    // Mark winning response as accepted, others as rejected
    const responses = await this.getResponses(rfqId);
    for (const r of responses) {
      const status: RFQResponseStatus = r.vendorId === vendorId ? "accepted" : "rejected";
      await this.db.update(rfqResponses).set({ status }).where(eq(rfqResponses.id, r.id));
    }

    return updated ?? null;
  }

  async close(rfqId: string) {
    const [updated] = await this.db.update(rfqs).set({
      status: "closed" as RFQStatus,
    }).where(eq(rfqs.id, rfqId)).returning();
    return updated ?? null;
  }
}
