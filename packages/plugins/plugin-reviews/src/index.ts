import { defineCommercePlugin } from "@porulle/core";
import { customerReviews } from "./schema.js";
import { ReviewService } from "./services/review-service.js";
import { buildReviewRoutes } from "./routes/reviews.js";
export type { Db } from "./types.js";
export { ReviewService } from "./services/review-service.js";

export function reviewsPlugin() {
  return defineCommercePlugin({
    id: "reviews",
    version: "1.0.0",
    permissions: [
      { scope: "reviews:admin", description: "Approve, reject, and reply to reviews." },
      { scope: "reviews:write", description: "Submit reviews." },
      { scope: "reviews:read", description: "View reviews and summaries." },
    ],
    schema: () => ({ customerReviews }),
    hooks: () => [],

    routes: (ctx) => {
      const db = ctx.database.db;
      if (!db) return [];
      const customers = ctx.services?.customers as {
        getByUserId(
          userId: string,
          actor?: import("@porulle/core").Actor | null,
        ): Promise<{ ok: true; value: { id: string } } | { ok: false; error: unknown }>;
      } | undefined;
      return buildReviewRoutes(
        new ReviewService(db, customers ? { customers } : undefined),
        ctx,
      );
    },
  });
}
