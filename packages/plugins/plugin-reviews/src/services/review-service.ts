import { eq, and, sql } from "@porulle/core/drizzle";
import { Ok, Err } from "@porulle/core";
import type { PluginResult } from "@porulle/core";
import type { Actor } from "@porulle/core";
import { customerReviews } from "../schema.js";
import type { Db, Review } from "../types.js";

export interface ReviewSummary {
  averageRating: number;
  totalCount: number;
  distribution: Record<number, number>;
}

export class ReviewService {
  constructor(
    private db: Db,
    private services?: {
      customers?: {
        getByUserId(
          userId: string,
          actor?: Actor | null,
        ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: unknown }>;
      };
    },
  ) {}

  async submit(orgId: string, input: {
    customerId?: string;
    entityId: string;
    orderId?: string;
    rating: number;
    title?: string;
    body?: string;
  }, actor: Actor | null): Promise<PluginResult<Review>> {
    if (input.rating < 1 || input.rating > 5 || !Number.isInteger(input.rating)) {
      return Err("Rating must be an integer between 1 and 5");
    }
    if (!actor?.userId) {
      return Err("Authentication required");
    }
    const staffRoles = new Set(["staff", "admin", "owner", "ai_agent", "service"]);
    const isStaff = typeof actor.role === "string" && staffRoles.has(actor.role);

    let resolvedCustomerId: string | null = null;
    if (isStaff) {
      resolvedCustomerId = input.customerId ?? null;
    } else {
      const customers = this.services?.customers;
      if (!customers?.getByUserId) {
        return Err("Customer resolution is not configured");
      }
      const profile = await customers.getByUserId(actor.userId, actor);
      if (!profile.ok) {
        return Err("Customer profile not found");
      }
      resolvedCustomerId = profile.value.id;
    }

    const isVerified = input.orderId != null;
    const rows = await this.db.insert(customerReviews).values({
      organizationId: orgId,
      customerId: resolvedCustomerId,
      entityId: input.entityId,
      orderId: input.orderId ?? null,
      rating: input.rating,
      title: input.title ?? null,
      body: input.body ?? null,
      isVerified,
    }).returning();
    return Ok(rows[0]!);
  }

  async listForEntity(orgId: string, entityId: string, publishedOnly?: boolean): Promise<PluginResult<Review[]>> {
    const conditions = [
      eq(customerReviews.organizationId, orgId),
      eq(customerReviews.entityId, entityId),
    ];
    if (publishedOnly) {
      conditions.push(eq(customerReviews.isPublished, true));
    }
    const rows = await this.db.select().from(customerReviews).where(and(...conditions));
    return Ok(rows);
  }

  async getSummary(orgId: string, entityId: string): Promise<PluginResult<ReviewSummary>> {
    const rows = await this.db.select({
      rating: customerReviews.rating,
      count: sql<number>`count(*)::int`,
    })
      .from(customerReviews)
      .where(and(
        eq(customerReviews.organizationId, orgId),
        eq(customerReviews.entityId, entityId),
      ))
      .groupBy(customerReviews.rating);

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let totalCount = 0;
    let totalSum = 0;
    for (const row of rows) {
      distribution[row.rating] = row.count;
      totalCount += row.count;
      totalSum += row.rating * row.count;
    }
    const averageRating = totalCount > 0 ? Math.round((totalSum / totalCount) * 100) / 100 : 0;
    return Ok({ averageRating, totalCount, distribution });
  }

  async approve(orgId: string, id: string): Promise<PluginResult<Review>> {
    const rows = await this.db.update(customerReviews)
      .set({ status: "approved", isPublished: true, updatedAt: new Date() })
      .where(and(eq(customerReviews.organizationId, orgId), eq(customerReviews.id, id)))
      .returning();
    if (rows.length === 0) return Err("Review not found");
    return Ok(rows[0]!);
  }

  async reject(orgId: string, id: string): Promise<PluginResult<Review>> {
    const rows = await this.db.update(customerReviews)
      .set({ status: "rejected", isPublished: false, updatedAt: new Date() })
      .where(and(eq(customerReviews.organizationId, orgId), eq(customerReviews.id, id)))
      .returning();
    if (rows.length === 0) return Err("Review not found");
    return Ok(rows[0]!);
  }

  async reply(orgId: string, id: string, response: string, responseBy: string): Promise<PluginResult<Review>> {
    const rows = await this.db.update(customerReviews)
      .set({ response, responseBy, responseAt: new Date(), updatedAt: new Date() })
      .where(and(eq(customerReviews.organizationId, orgId), eq(customerReviews.id, id)))
      .returning();
    if (rows.length === 0) return Err("Review not found");
    return Ok(rows[0]!);
  }

  async listByCustomer(orgId: string, customerId: string): Promise<PluginResult<Review[]>> {
    const rows = await this.db.select().from(customerReviews)
      .where(and(
        eq(customerReviews.organizationId, orgId),
        eq(customerReviews.customerId, customerId),
      ));
    return Ok(rows);
  }
}
