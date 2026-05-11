import { eq, and, or, ilike, desc } from "@porulle/core/drizzle";
import { vendors, vendorDocuments } from "../schema.js";
import type { Db, VendorStatus, VerificationStatus, DocumentStatus } from "../types.js";

export class VendorService {
  constructor(private db: Db) {}

  async create(orgId: string, data: {
    name: string;
    slug?: string;
    email?: string;
    description?: string;
    commissionRateBps?: number;
    metadata?: Record<string, unknown>;
  }) {
    const [vendor] = await this.db.insert(vendors).values({
      organizationId: orgId,
      name: data.name,
      slug: data.slug ?? data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      email: data.email,
      description: data.description,
      commissionRateBps: data.commissionRateBps,
      metadata: data.metadata ?? {},
    }).returning();
    return vendor;
  }

  async getById(id: string) {
    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.id, id));
    return vendor ?? null;
  }

  async getBySlug(slug: string) {
    const [vendor] = await this.db.select().from(vendors).where(eq(vendors.slug, slug));
    return vendor ?? null;
  }

  async list(filters?: { status?: string; tier?: string; search?: string }) {
    let query = this.db.select().from(vendors).$dynamic();
    const conditions = [];

    if (filters?.status) conditions.push(eq(vendors.status, filters.status));
    if (filters?.tier) conditions.push(eq(vendors.tier, filters.tier));
    if (filters?.search) {
      conditions.push(
        or(ilike(vendors.name, `%${filters.search}%`), ilike(vendors.email, `%${filters.search}%`)),
      );
    }

    if (conditions.length > 0) {
      query = query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
    }

    return query.orderBy(desc(vendors.createdAt));
  }

  async update(id: string, data: Partial<{
    name: string; slug: string; email: string; description: string;
    logoUrl: string; bannerUrl: string; contactPhone: string;
    businessAddress: Record<string, unknown>; bankAccount: Record<string, unknown>;
    taxId: string; commissionRateBps: number; payoutSchedule: string;
    payoutMinimumCents: number; holdbackDays: number; metadata: Record<string, unknown>;
    approvedCategories: string[] | null; tier: string;
  }>) {
    const [updated] = await this.db.update(vendors).set({
      ...data,
      updatedAt: new Date(),
    }).where(eq(vendors.id, id)).returning();
    return updated ?? null;
  }

  async approve(id: string) {
    const [updated] = await this.db.update(vendors).set({
      status: "approved",
      updatedAt: new Date(),
    }).where(eq(vendors.id, id)).returning();
    return updated ?? null;
  }

  async reject(id: string, reason: string) {
    const [updated] = await this.db.update(vendors).set({
      status: "pending" as VendorStatus,
      verificationStatus: "rejected" as VerificationStatus,
      rejectionReason: reason,
      updatedAt: new Date(),
    }).where(eq(vendors.id, id)).returning();
    return updated ?? null;
  }

  async suspend(id: string, reason: string) {
    const [updated] = await this.db.update(vendors).set({
      status: "suspended" as VendorStatus,
      suspensionReason: reason,
      suspendedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(vendors.id, id)).returning();
    return updated ?? null;
  }

  async reinstate(id: string) {
    const [updated] = await this.db.update(vendors).set({
      status: "approved" as VendorStatus,
      suspensionReason: null,
      suspendedAt: null,
      updatedAt: new Date(),
    }).where(eq(vendors.id, id)).returning();
    return updated ?? null;
  }

  // ─── Documents ───────────────────────────────────────────────────────────

  async uploadDocument(vendorId: string, data: { type: string; fileUrl: string }) {
    const [doc] = await this.db.insert(vendorDocuments).values({
      vendorId,
      type: data.type,
      fileUrl: data.fileUrl,
    }).returning();

    // Update vendor verification status
    await this.db.update(vendors).set({
      verificationStatus: "documents_submitted" as VerificationStatus,
      updatedAt: new Date(),
    }).where(eq(vendors.id, vendorId));

    return doc;
  }

  async listDocuments(vendorId: string) {
    return this.db.select().from(vendorDocuments)
      .where(eq(vendorDocuments.vendorId, vendorId))
      .orderBy(desc(vendorDocuments.uploadedAt));
  }

  async approveDocument(docId: string, notes?: string) {
    const [updated] = await this.db.update(vendorDocuments).set({
      status: "approved" as DocumentStatus,
      reviewerNotes: notes,
      reviewedAt: new Date(),
    }).where(eq(vendorDocuments.id, docId)).returning();
    return updated ?? null;
  }

  async rejectDocument(docId: string, notes?: string) {
    const [updated] = await this.db.update(vendorDocuments).set({
      status: "rejected" as DocumentStatus,
      reviewerNotes: notes,
      reviewedAt: new Date(),
    }).where(eq(vendorDocuments.id, docId)).returning();
    return updated ?? null;
  }
}
