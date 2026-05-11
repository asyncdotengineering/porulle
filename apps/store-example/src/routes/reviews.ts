/**
 * Review routes — app-level custom routes for the reviews table.
 *
 * Demonstrates:
 * - Querying a custom table with FK joins to core tables
 * - No plugin needed — just routes + schema in commerce.config.ts
 *
 * SECURITY: Mutation routes (POST, PATCH) require an authenticated actor
 * with the right permission. POST takes the customer profile from the
 * actor — never trusts a body-supplied customerId for ownership purposes.
 * PATCH /approve requires reviews:moderate. Without these guards, anyone
 * could spam reviews or self-approve them — see SECURITY-AUDIT.md
 * CRITICAL-7.
 */

import type { Hono } from "hono";
import { eq, desc, avg, count } from "@porulle/core/drizzle";
import { reviews } from "../schema/reviews.js";
import { sellableEntities } from "@porulle/core/schema";
import type { PostgresJsDatabase } from "@porulle/core/drizzle";

interface ReviewActor {
  type?: string;
  userId?: string;
  organizationId?: string | null;
  role?: string;
  permissions?: string[];
}

function db(raw: unknown): PostgresJsDatabase<Record<string, unknown>> {
  return raw as PostgresJsDatabase<Record<string, unknown>>;
}

function getActor(c: unknown): ReviewActor | null {
  const ctx = c as { var?: { actor?: ReviewActor | null } };
  return ctx.var?.actor ?? null;
}

function hasPerm(actor: ReviewActor | null, required: string): boolean {
  if (!actor) return false;
  const perms = actor.permissions ?? [];
  if (perms.includes("*:*")) return true;
  const [resource] = required.split(":");
  if (resource && perms.includes(`${resource}:*`)) return true;
  return perms.includes(required);
}

export function reviewRoutes(app: Hono, kernel: unknown) {
  const k = kernel as {
    database: { db: unknown };
    services: {
      customers: {
        getByUserId(userId: string): Promise<{ ok: boolean; value?: { id: string } }>;
      };
    };
  };

  // POST /api/reviews — submit a review.
  // Requires: authenticated actor. customerId resolved from actor; only
  // moderator-class actors (reviews:write) can override via body.
  app.post("/api/reviews", async (c) => {
    const actor = getActor(c);
    if (!actor) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Login required to submit a review." } }, 401);
    }

    const body = await c.req.json();
    const drizzle = db(k.database.db);

    let customerId: string | null = null;
    if (actor.userId) {
      const customerResult = await k.services.customers.getByUserId(actor.userId);
      if (customerResult.ok && customerResult.value) {
        customerId = customerResult.value.id;
      }
    }
    // Moderators / staff with reviews:write can override the customerId
    if (body.customerId && hasPerm(actor, "reviews:write")) {
      customerId = body.customerId;
    }
    if (!customerId) {
      return c.json({ error: { code: "FORBIDDEN", message: "Cannot submit review without a customer profile." } }, 403);
    }

    const [review] = await drizzle
      .insert(reviews)
      .values({
        entityId: body.entityId,
        customerId,
        rating: body.rating,
        title: body.title ?? null,
        body: body.body ?? null,
      })
      .returning();

    return c.json({ data: review }, 201);
  });

  // GET /api/reviews/:entityId — list reviews for a product.
  // Public read (storefront browse) — intentional.
  app.get("/api/reviews/:entityId", async (c) => {
    const entityId = c.req.param("entityId");
    const drizzle = db(k.database.db);

    const rows = await drizzle
      .select({
        review: reviews,
        productSlug: sellableEntities.slug,
        productType: sellableEntities.type,
      })
      .from(reviews)
      .innerJoin(sellableEntities, eq(reviews.entityId, sellableEntities.id))
      .where(eq(reviews.entityId, entityId))
      .orderBy(desc(reviews.createdAt));

    return c.json({
      data: rows.map((r) => ({
        id: r.review.id,
        rating: r.review.rating,
        title: r.review.title,
        body: r.review.body,
        status: r.review.status,
        customerId: r.review.customerId,
        createdAt: r.review.createdAt,
        product: {
          slug: r.productSlug,
          type: r.productType,
        },
      })),
    });
  });

  // GET /api/reviews/:entityId/summary — average rating + count. Public.
  app.get("/api/reviews/:entityId/summary", async (c) => {
    const entityId = c.req.param("entityId");
    const drizzle = db(k.database.db);

    const [summary] = await drizzle
      .select({
        averageRating: avg(reviews.rating).mapWith(Number),
        totalReviews: count(reviews.id),
      })
      .from(reviews)
      .where(eq(reviews.entityId, entityId));

    return c.json({
      data: {
        entityId,
        averageRating: summary?.averageRating ?? 0,
        totalReviews: summary?.totalReviews ?? 0,
      },
    });
  });

  // PATCH /api/reviews/:reviewId/approve — moderate a review.
  // Requires: reviews:moderate permission. Without this gate any caller
  // could approve reviews including their own spam.
  app.patch("/api/reviews/:reviewId/approve", async (c) => {
    const actor = getActor(c);
    if (!actor) {
      return c.json({ error: { code: "UNAUTHENTICATED", message: "Login required to moderate reviews." } }, 401);
    }
    if (!hasPerm(actor, "reviews:moderate")) {
      return c.json({ error: { code: "FORBIDDEN", message: "Permission 'reviews:moderate' required." } }, 403);
    }

    const reviewId = c.req.param("reviewId");
    const drizzle = db(k.database.db);

    const [updated] = await drizzle
      .update(reviews)
      .set({ status: "approved" })
      .where(eq(reviews.id, reviewId))
      .returning();

    if (!updated) {
      return c.json({ error: { code: "NOT_FOUND", message: "Review not found" } }, 404);
    }

    return c.json({ data: updated });
  });
}
