import { router } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { Actor } from "@porulle/core";
import type { ReviewService } from "../services/review-service.js";
import type { PluginRouteRegistration } from "@porulle/core";

export function buildReviewRoutes(
  service: ReviewService,
  ctx: { services?: Record<string, unknown>; database?: { db: unknown } },
): PluginRouteRegistration[] {
  const r = router("Reviews", "/reviews", ctx);

  r.post("/").summary("Submit review").permission("reviews:write")
    .input(z.object({
      customerId: z.string().uuid().optional(),
      entityId: z.string().uuid(),
      orderId: z.string().uuid().optional(),
      rating: z.number().int().min(1).max(5),
      title: z.string().optional(),
      body: z.string().optional(),
    }))
    .handler(async ({ input, orgId, actor }) => {
      const body = input as {
        customerId?: string; entityId: string; orderId?: string;
        rating: number; title?: string; body?: string;
      };
      const result = await service.submit(orgId, body, (actor ?? null) as Actor | null);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/entity/{entityId}").summary("List reviews for entity").permission("reviews:read")
    .handler(async ({ params, orgId }) => {
      const result = await service.listForEntity(orgId, params.entityId!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/entity/{entityId}/summary").summary("Review summary for entity").permission("reviews:read")
    .handler(async ({ params, orgId }) => {
      const result = await service.getSummary(orgId, params.entityId!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.patch("/{id}/approve").summary("Approve review").permission("reviews:admin")
    .handler(async ({ params, orgId }) => {
      const result = await service.approve(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.patch("/{id}/reject").summary("Reject review").permission("reviews:admin")
    .handler(async ({ params, orgId }) => {
      const result = await service.reject(orgId, params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.post("/{id}/reply").summary("Reply to review").permission("reviews:admin")
    .input(z.object({
      response: z.string().min(1),
      responseBy: z.string().min(1),
    }))
    .handler(async ({ params, input, orgId }) => {
      const body = input as { response: string; responseBy: string };
      const result = await service.reply(orgId, params.id!, body.response, body.responseBy);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  r.get("/mine").summary("My reviews").permission("reviews:write")
    .handler(async ({ actor, orgId }) => {
      // Use the authenticated actor's userId — never accept customerId from query
      if (!actor?.userId) throw new Error("Authentication required");
      const result = await service.listByCustomer(orgId, actor.userId);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });

  return r.routes();
}
