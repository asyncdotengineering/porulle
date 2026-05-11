import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { z } from "@hono/zod-openapi";
import type { DisputeService } from "../services/dispute.js";
import type { ReturnService } from "../services/return.js";
import type { ReviewService } from "../services/review.js";
import type { DisputeResolution, ReviewStatus } from "../types.js";
import {
  OpenDisputeBodySchema,
  RespondDisputeBodySchema,
  ResolveDisputeBodySchema,
  RequestReturnBodySchema,
  ShipBackReturnBodySchema,
  CreateReviewBodySchema,
  ModerateReviewBodySchema,
} from "../schemas/disputes-returns-reviews.js";
import { stripUndefined } from "./util.js";

export function buildDisputesReturnsReviewsRoutes(services: {
  dispute: DisputeService;
  return: ReturnService;
  review: ReviewService;
}): PluginRouteRegistration[] {
  // ═══════════════════════════════════════════════════════════════════════════
  // DISPUTES
  // ═══════════════════════════════════════════════════════════════════════════
  const disputes = router("Marketplace - Disputes", "/marketplace/disputes");

  disputes.post("/")
    .summary("Open a dispute")
    .auth()
    .input(OpenDisputeBodySchema)
    .handler(async ({ input }) => {
      const body = input as z.infer<typeof OpenDisputeBodySchema>;
      return services.dispute.open(stripUndefined({
        subOrderId: body.subOrderId,
        openedBy: body.openedBy,
        reason: body.reason,
        description: body.description,
      }));
    });

  disputes.get("/")
    .summary("List disputes")
    .auth()
    .handler(async ({ query }) => {
      return services.dispute.list(stripUndefined({
        status: query.status as string | undefined,
        subOrderId: query.subOrderId as string | undefined,
      }));
    });

  disputes.get("/{id}")
    .summary("Get dispute by ID")
    .auth()
    .handler(async ({ params }) => {
      const dispute = await services.dispute.getById(params.id!);
      if (!dispute) throw new Error("Dispute not found");
      return dispute;
    });

  disputes.post("/{id}/respond")
    .summary("Respond to a dispute")
    .auth()
    .input(RespondDisputeBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof RespondDisputeBodySchema>;
      return services.dispute.respond(params.id!, stripUndefined({
        party: body.party,
        note: body.note,
        url: body.url,
      }));
    });

  disputes.post("/{id}/escalate")
    .summary("Escalate a dispute")
    .auth()
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const updated = await services.dispute.escalate(params.id!);
      if (!updated) throw new Error("Dispute not found");
      return updated;
    });

  disputes.post("/{id}/resolve")
    .summary("Resolve a dispute")
    .auth()
    .permission("marketplace:admin")
    .input(ResolveDisputeBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof ResolveDisputeBodySchema>;
      const updated = await services.dispute.resolve(params.id!, stripUndefined({
        resolution: body.resolution as DisputeResolution,
        notes: body.notes,
        refundAmountCents: body.refundAmountCents,
        resolvedBy: body.resolvedBy,
      }));
      if (!updated) throw new Error("Dispute not found");
      return updated;
    });

  // ═══════════════════════════════════════════════════════════════════════════
  // RETURNS
  // ═══════════════════════════════════════════════════════════════════════════
  const returns = router("Marketplace - Returns", "/marketplace/returns");

  returns.post("/")
    .summary("Request a return")
    .auth()
    .input(RequestReturnBodySchema)
    .handler(async ({ input }) => {
      const body = input as z.infer<typeof RequestReturnBodySchema>;
      return services.return.request(stripUndefined({
        subOrderId: body.subOrderId,
        customerId: body.customerId,
        reason: body.reason,
        description: body.description,
        lineItems: body.lineItems as { entityId: string; quantity: number; reason?: string }[] | undefined,
      }));
    });

  returns.get("/")
    .summary("List returns")
    .auth()
    .handler(async ({ query }) => {
      return services.return.list(stripUndefined({
        subOrderId: query.subOrderId as string | undefined,
        status: query.status as string | undefined,
      }));
    });

  returns.get("/{id}")
    .summary("Get return by ID")
    .auth()
    .handler(async ({ params }) => {
      const ret = await services.return.getById(params.id!);
      if (!ret) throw new Error("Return not found");
      return ret;
    });

  returns.post("/{id}/ship-back")
    .summary("Ship back a return")
    .auth()
    .input(ShipBackReturnBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof ShipBackReturnBodySchema>;
      const updated = await services.return.shipBack(params.id!, body.trackingNumber);
      if (!updated) throw new Error("Return not found");
      return updated;
    });

  returns.post("/{id}/receive")
    .summary("Mark a return as received")
    .auth()
    .handler(async ({ params }) => {
      const updated = await services.return.receive(params.id!);
      if (!updated) throw new Error("Return not found");
      return updated;
    });

  // ═══════════════════════════════════════════════════════════════════════════
  // REVIEWS
  // ═══════════════════════════════════════════════════════════════════════════
  const vendorReviews = router("Marketplace - Reviews", "/marketplace/vendors");

  vendorReviews.post("/{id}/reviews")
    .summary("Create a vendor review")
    .auth()
    .input(CreateReviewBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof CreateReviewBodySchema>;
      return services.review.create(stripUndefined({
        vendorId: params.id!,
        customerId: body.customerId,
        orderId: body.orderId,
        rating: body.rating,
        title: body.title,
        body: body.body,
      }));
    });

  vendorReviews.get("/{id}/reviews")
    .summary("List reviews for a vendor")
    .auth()
    .handler(async ({ params }) => {
      return services.review.getForVendor(params.id!);
    });

  const reviewsMod = router("Marketplace - Reviews", "/marketplace/reviews");

  reviewsMod.patch("/{id}")
    .summary("Moderate a review (update status)")
    .auth()
    .permission("marketplace:admin")
    .input(ModerateReviewBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof ModerateReviewBodySchema>;
      const updated = await services.review.moderate(params.id!, body.status as ReviewStatus);
      if (!updated) throw new Error("Review not found");
      return updated;
    });

  return [
    ...disputes.routes(),
    ...returns.routes(),
    ...vendorReviews.routes(),
    ...reviewsMod.routes(),
  ];
}
