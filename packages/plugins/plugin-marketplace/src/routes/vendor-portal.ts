import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { z } from "@hono/zod-openapi";
import type { VendorService } from "../services/vendor.js";
import type { SubOrderService } from "../services/sub-order.js";
import type { PayoutService } from "../services/payout.js";
import type { ReviewService } from "../services/review.js";
import type { ReturnService } from "../services/return.js";
import { vendorEntities } from "../schema.js";
import { eq } from "@porulle/core/drizzle";
import {
  UpdateVendorProfileBodySchema,
  UploadVendorDocumentBodySchema,
  ShipSubOrderBodySchema,
  CancelSubOrderBodySchema,
  RespondToReviewBodySchema,
  ApproveReturnBodySchema,
  RejectReturnBodySchema,
} from "../schemas/vendor-portal.js";
import { stripUndefined, stripVendorSecrets } from "./util.js";

/** Helper to extract vendorId from actor and throw if missing. */
function requireVendorId(actor: { vendorId?: string | null } | null): string {
  const vendorId = actor?.vendorId;
  if (!vendorId) throw new Error("Forbidden");
  return vendorId;
}

export function buildVendorPortalRoutes(services: {
  vendor: VendorService;
  subOrder: SubOrderService;
  payout: PayoutService;
  review: ReviewService;
  return: ReturnService;
}): PluginRouteRegistration[] {
  const r = router("Marketplace - Vendor Portal", "/marketplace/vendor/me");

  // ─── Get my vendor profile ─────────────────────────────────────────────────
  r.get("/")
    .summary("Get my vendor profile")
    .auth()
    .handler(async ({ actor }) => {
      const vendorId = requireVendorId(actor);
      const vendor = await services.vendor.getById(vendorId);
      if (!vendor) throw new Error("Vendor not found");
      return stripVendorSecrets(vendor);
    });

  // ─── Update my vendor profile ──────────────────────────────────────────────
  r.patch("/")
    .summary("Update my vendor profile")
    .auth()
    .input(UpdateVendorProfileBodySchema)
    .handler(async ({ actor, input }) => {
      const vendorId = requireVendorId(actor);
      const body = input as z.infer<typeof UpdateVendorProfileBodySchema>;
      const updated = await services.vendor.update(vendorId, stripUndefined(body));
      if (!updated) throw new Error("Vendor not found");
      return stripVendorSecrets(updated);
    });

  // ─── Upload document ───────────────────────────────────────────────────────
  r.post("/documents")
    .summary("Upload a document for my vendor profile")
    .auth()
    .input(UploadVendorDocumentBodySchema)
    .handler(async ({ actor, input }) => {
      const vendorId = requireVendorId(actor);
      const body = input as z.infer<typeof UploadVendorDocumentBodySchema>;
      return services.vendor.uploadDocument(vendorId, {
        type: body.type,
        fileUrl: body.fileUrl,
      });
    });

  // ─── List my documents ─────────────────────────────────────────────────────
  r.get("/documents")
    .summary("List my vendor documents")
    .auth()
    .handler(async ({ actor }) => {
      const vendorId = requireVendorId(actor);
      return services.vendor.listDocuments(vendorId);
    });

  // ─── List my products ──────────────────────────────────────────────────────
  r.get("/products")
    .summary("List my products")
    .auth()
    .handler(async ({ actor, db }) => {
      const vendorId = requireVendorId(actor);
      const drizzle = db as import("../types.js").Db;
      const entities = await drizzle
        .select()
        .from(vendorEntities)
        .where(eq(vendorEntities.vendorId, vendorId));
      return entities;
    });

  // ─── List my sub-orders ────────────────────────────────────────────────────
  r.get("/orders")
    .summary("List my sub-orders")
    .auth()
    .handler(async ({ actor, query }) => {
      const vendorId = requireVendorId(actor);
      const status = query.status as string | undefined;
      return services.subOrder.listByVendor(vendorId, stripUndefined({ status }));
    });

  // ─── Get single sub-order ──────────────────────────────────────────────────
  r.get("/orders/{subOrderId}")
    .summary("Get a single sub-order")
    .auth()
    .handler(async ({ actor, params }) => {
      const vendorId = requireVendorId(actor);
      const subOrder = await services.subOrder.getById(params.subOrderId!);
      if (!subOrder) throw new Error("Sub-order not found");
      if (subOrder.vendorId !== vendorId) throw new Error("Forbidden");
      return subOrder;
    });

  // ─── Confirm sub-order ─────────────────────────────────────────────────────
  r.post("/orders/{subOrderId}/confirm")
    .summary("Confirm a sub-order")
    .auth()
    .handler(async ({ actor, params }) => {
      const vendorId = requireVendorId(actor);
      const subOrder = await services.subOrder.getById(params.subOrderId!);
      if (!subOrder) throw new Error("Sub-order not found");
      if (subOrder.vendorId !== vendorId) throw new Error("Forbidden");
      return services.subOrder.confirm(params.subOrderId!);
    });

  // ─── Ship sub-order ────────────────────────────────────────────────────────
  r.post("/orders/{subOrderId}/ship")
    .summary("Ship a sub-order")
    .auth()
    .input(ShipSubOrderBodySchema)
    .handler(async ({ actor, params, input }) => {
      const vendorId = requireVendorId(actor);
      const body = input as z.infer<typeof ShipSubOrderBodySchema>;
      const subOrder = await services.subOrder.getById(params.subOrderId!);
      if (!subOrder) throw new Error("Sub-order not found");
      if (subOrder.vendorId !== vendorId) throw new Error("Forbidden");
      return services.subOrder.ship(params.subOrderId!, {
        trackingNumber: body.trackingNumber,
        carrier: body.carrier,
      });
    });

  // ─── Deliver sub-order ─────────────────────────────────────────────────────
  r.post("/orders/{subOrderId}/deliver")
    .summary("Mark a sub-order as delivered")
    .auth()
    .handler(async ({ actor, params }) => {
      const vendorId = requireVendorId(actor);
      const subOrder = await services.subOrder.getById(params.subOrderId!);
      if (!subOrder) throw new Error("Sub-order not found");
      if (subOrder.vendorId !== vendorId) throw new Error("Forbidden");
      return services.subOrder.deliver(params.subOrderId!);
    });

  // ─── Cancel sub-order ──────────────────────────────────────────────────────
  r.post("/orders/{subOrderId}/cancel")
    .summary("Cancel a sub-order")
    .auth()
    .input(CancelSubOrderBodySchema)
    .handler(async ({ actor, params, input }) => {
      const vendorId = requireVendorId(actor);
      const body = input as z.infer<typeof CancelSubOrderBodySchema>;
      const subOrder = await services.subOrder.getById(params.subOrderId!);
      if (!subOrder) throw new Error("Sub-order not found");
      if (subOrder.vendorId !== vendorId) throw new Error("Forbidden");
      return services.subOrder.cancel(params.subOrderId!, body.reason);
    });

  // ─── List my payouts ───────────────────────────────────────────────────────
  r.get("/payouts")
    .summary("List my payouts")
    .auth()
    .handler(async ({ actor }) => {
      const vendorId = requireVendorId(actor);
      return services.payout.listPayouts({ vendorId });
    });

  // ─── My balance ────────────────────────────────────────────────────────────
  r.get("/balance")
    .summary("Get my balance")
    .auth()
    .handler(async ({ actor }) => {
      const vendorId = requireVendorId(actor);
      const balance = await services.payout.getBalance(vendorId);
      const ledger = await services.payout.getLedger(vendorId);
      return { balanceCents: balance, ledger };
    });

  // ─── My analytics ──────────────────────────────────────────────────────────
  r.get("/analytics")
    .summary("Get my analytics")
    .auth()
    .handler(async ({ actor }) => {
      const vendorId = requireVendorId(actor);
      const rating = await services.review.getAggregateRating(vendorId);
      const balance = await services.payout.getBalance(vendorId);
      return { rating, balanceCents: balance };
    });

  // ─── My reviews ────────────────────────────────────────────────────────────
  r.get("/reviews")
    .summary("List my reviews")
    .auth()
    .handler(async ({ actor }) => {
      const vendorId = requireVendorId(actor);
      return services.review.getForVendor(vendorId, true);
    });

  // ─── Respond to review ─────────────────────────────────────────────────────
  r.post("/reviews/{id}/respond")
    .summary("Respond to a review")
    .auth()
    .input(RespondToReviewBodySchema)
    .handler(async ({ actor, params, input }) => {
      const vendorId = requireVendorId(actor);
      const body = input as z.infer<typeof RespondToReviewBodySchema>;
      // IDOR prevention: verify the review belongs to this vendor
      const vendorReviews = await services.review.getForVendor(vendorId, true);
      const ownsReview = vendorReviews.some((rev: { id: string }) => rev.id === params.id!);
      if (!ownsReview) throw new Error("Forbidden: review does not belong to this vendor");
      const updated = await services.review.respond(params.id!, body.response);
      if (!updated) throw new Error("Review not found");
      return updated;
    });

  // ─── My returns ────────────────────────────────────────────────────────────
  r.get("/returns")
    .summary("List my returns")
    .auth()
    .handler(async ({ actor }) => {
      const vendorId = requireVendorId(actor);
      return services.return.listByVendor(vendorId);
    });

  // ─── Approve return ────────────────────────────────────────────────────────
  r.post("/returns/{id}/approve")
    .summary("Approve a return request")
    .auth()
    .input(ApproveReturnBodySchema)
    .handler(async ({ actor, params, input }) => {
      const vendorId = requireVendorId(actor);
      const ret = await services.return.getById(params.id!);
      if (!ret) throw new Error("Return not found");
      const subOrder = await services.subOrder.getById(ret.subOrderId);
      if (!subOrder || subOrder.vendorId !== vendorId) throw new Error("Forbidden");
      const body = input as z.infer<typeof ApproveReturnBodySchema>;
      const updated = await services.return.vendorApprove(params.id!, body.refundAmountCents);
      if (!updated) throw new Error("Return not found");
      return updated;
    });

  // ─── Reject return ─────────────────────────────────────────────────────────
  r.post("/returns/{id}/reject")
    .summary("Reject a return request")
    .auth()
    .input(RejectReturnBodySchema)
    .handler(async ({ actor, params, input }) => {
      const vendorId = requireVendorId(actor);
      const ret = await services.return.getById(params.id!);
      if (!ret) throw new Error("Return not found");
      const subOrder = await services.subOrder.getById(ret.subOrderId);
      if (!subOrder || subOrder.vendorId !== vendorId) throw new Error("Forbidden");
      const body = input as z.infer<typeof RejectReturnBodySchema>;
      const updated = await services.return.vendorReject(params.id!, body.notes);
      if (!updated) throw new Error("Return not found");
      return updated;
    });

  return r.routes();
}
