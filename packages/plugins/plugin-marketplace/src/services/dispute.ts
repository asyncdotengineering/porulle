import { eq, and, desc } from "@porulle/core/drizzle";
import { disputes } from "../schema.js";
import type { Db, DisputeStatus, DisputeResolution, MarketplacePluginOptions } from "../types.js";

export class DisputeService {
  constructor(
    private db: Db,
    private options: MarketplacePluginOptions,
  ) {}

  async open(data: {
    subOrderId: string;
    openedBy: string;
    reason: string;
    description?: string;
  }) {
    const deadlineDays = this.options.vendorResponseDeadlineDays ?? 3;
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + deadlineDays);

    const [dispute] = await this.db.insert(disputes).values({
      subOrderId: data.subOrderId,
      openedBy: data.openedBy,
      reason: data.reason,
      description: data.description,
      status: "vendor_response_pending",
      deadlineAt: deadline,
    }).returning();
    return dispute;
  }

  async getById(id: string) {
    const [dispute] = await this.db.select().from(disputes).where(eq(disputes.id, id));
    return dispute ?? null;
  }

  async list(filters?: { status?: string; subOrderId?: string }) {
    let query = this.db.select().from(disputes).$dynamic();
    const conditions = [];
    if (filters?.status) conditions.push(eq(disputes.status, filters.status));
    if (filters?.subOrderId) conditions.push(eq(disputes.subOrderId, filters.subOrderId));
    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
    }
    return query.orderBy(desc(disputes.openedAt));
  }

  async respond(id: string, data: { party: string; note: string; url?: string }) {
    const dispute = await this.getById(id);
    if (!dispute) throw new Error("Dispute not found.");

    const evidence = [...(dispute.evidence as Array<{ party: string; type: string; url?: string; note?: string; at: string }> ?? [])];
    const entry: { party: string; type: string; note: string; at: string; url?: string } = {
      party: data.party,
      type: "response",
      note: data.note,
      at: new Date().toISOString(),
    };
    if (data.url) entry.url = data.url;
    evidence.push(entry);

    const [updated] = await this.db.update(disputes).set({
      evidence,
      status: "platform_review",
    }).where(eq(disputes.id, id)).returning();
    return updated;
  }

  async escalate(id: string) {
    const [updated] = await this.db.update(disputes).set({
      status: "escalated" as DisputeStatus,
    }).where(eq(disputes.id, id)).returning();
    return updated ?? null;
  }

  async resolve(id: string, data: {
    resolution: DisputeResolution;
    notes?: string;
    refundAmountCents?: number;
    resolvedBy: string;
  }) {
    const [updated] = await this.db.update(disputes).set({
      status: "resolved" as DisputeStatus,
      resolution: data.resolution,
      resolutionNotes: data.notes,
      refundAmountCents: data.refundAmountCents,
      resolvedBy: data.resolvedBy,
      resolvedAt: new Date(),
    }).where(eq(disputes.id, id)).returning();
    return updated ?? null;
  }
}
