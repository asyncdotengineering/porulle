import { eq, and, desc, sql, avg } from "@porulle/core/drizzle";
import { vendorReviews } from "../schema.js";
import type { Db, ReviewStatus, MarketplacePluginOptions } from "../types.js";

export class ReviewService {
  constructor(
    private db: Db,
    private options: MarketplacePluginOptions,
  ) {}

  async create(data: {
    vendorId: string;
    customerId?: string;
    orderId?: string;
    rating: number;
    title?: string;
    body?: string;
  }) {
    if (data.rating < 1 || data.rating > 5) {
      throw new Error("Rating must be between 1 and 5.");
    }

    const status: ReviewStatus = this.options.reviewModerationEnabled ? "pending" : "published";

    const [review] = await this.db.insert(vendorReviews).values({
      vendorId: data.vendorId,
      customerId: data.customerId,
      orderId: data.orderId,
      rating: data.rating,
      title: data.title,
      body: data.body,
      status,
    }).returning();
    return review;
  }

  async getForVendor(vendorId: string, includeUnpublished = false) {
    let query = this.db.select().from(vendorReviews).$dynamic();
    if (includeUnpublished) {
      query = query.where(eq(vendorReviews.vendorId, vendorId));
    } else {
      query = query.where(
        and(eq(vendorReviews.vendorId, vendorId), eq(vendorReviews.status, "published")),
      );
    }
    return query.orderBy(desc(vendorReviews.createdAt));
  }

  async getAggregateRating(vendorId: string): Promise<{ average: number; count: number }> {
    const rows = await this.db.select({
      avg: sql<number>`COALESCE(AVG(${vendorReviews.rating}), 0)`,
      count: sql<number>`COUNT(*)`,
    }).from(vendorReviews)
      .where(and(eq(vendorReviews.vendorId, vendorId), eq(vendorReviews.status, "published")));

    const row = rows[0];
    return {
      average: Math.round((Number(row?.avg) || 0) * 10) / 10,
      count: Number(row?.count) || 0,
    };
  }

  async respond(reviewId: string, response: string) {
    const [updated] = await this.db.update(vendorReviews).set({
      vendorResponse: response,
      vendorRespondedAt: new Date(),
    }).where(eq(vendorReviews.id, reviewId)).returning();
    return updated ?? null;
  }

  async moderate(reviewId: string, status: ReviewStatus) {
    const [updated] = await this.db.update(vendorReviews).set({ status })
      .where(eq(vendorReviews.id, reviewId)).returning();
    return updated ?? null;
  }
}
