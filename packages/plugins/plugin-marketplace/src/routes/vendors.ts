import { router, resolveOrgId } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { z } from "@hono/zod-openapi";
import type { VendorService } from "../services/vendor.js";
import type { PayoutService } from "../services/payout.js";
import type { ReviewService } from "../services/review.js";
import type { MarketplacePluginOptions } from "../types.js";
import {
  CreateVendorBodySchema,
  UpdateVendorBodySchema,
  RejectVendorBodySchema,
  SuspendVendorBodySchema,
  UploadDocumentBodySchema,
} from "../schemas/vendors.js";
import { stripUndefined, stripVendorSecrets } from "./util.js";

export function buildVendorRoutes(services: {
  vendor: VendorService;
  payout: PayoutService;
  review: ReviewService;
}, options?: MarketplacePluginOptions): PluginRouteRegistration[] {
  const r = router("Marketplace - Vendors", "/marketplace/vendors");

  // ─── List vendors ──────────────────────────────────────────────────────────
  r.get("/")
    .summary("List all vendors")
    .permission("marketplace:admin")
    .handler(async ({ query }) => {
      const vendors = await services.vendor.list(stripUndefined({
        status: query.status as string | undefined,
        tier: query.tier as string | undefined,
        search: query.search as string | undefined,
      }));
      return vendors.map(stripVendorSecrets);
    });

  // ─── Create vendor ─────────────────────────────────────────────────────────
  r.post("/")
    .summary("Create a vendor")
    .permission("marketplace:admin")
    .input(CreateVendorBodySchema)
    .handler(async ({ input, actor }) => {
      const body = input as z.infer<typeof CreateVendorBodySchema>;
      const defaultBps = options?.defaultCommissionRateBps ?? 1000;
      return services.vendor.create(resolveOrgId(actor), stripUndefined({
        ...body,
        commissionRateBps: body.commissionRateBps ?? defaultBps,
      }));
    });

  // ─── Get vendor detail ─────────────────────────────────────────────────────
  r.get("/{id}")
    .summary("Get vendor detail")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      return stripVendorSecrets(vendor);
    });

  // ─── Update vendor ─────────────────────────────────────────────────────────
  r.patch("/{id}")
    .summary("Update a vendor")
    .permission("marketplace:admin")
    .input(UpdateVendorBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof UpdateVendorBodySchema>;
      const updated = await services.vendor.update(params.id!, stripUndefined(body));
      if (!updated) throw new Error("Vendor not found");
      return stripVendorSecrets(updated);
    });

  // ─── Approve vendor ────────────────────────────────────────────────────────
  r.post("/{id}/approve")
    .summary("Approve a vendor application")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      const approved = await services.vendor.approve(params.id!);
      if (!approved) throw new Error("Vendor not found");
      return stripVendorSecrets(approved);
    });

  // ─── Reject vendor ─────────────────────────────────────────────────────────
  r.post("/{id}/reject")
    .summary("Reject a vendor application")
    .permission("marketplace:admin")
    .input(RejectVendorBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof RejectVendorBodySchema>;
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      const rejected = await services.vendor.reject(params.id!, body.reason);
      if (!rejected) throw new Error("Vendor not found");
      return stripVendorSecrets(rejected);
    });

  // ─── Suspend vendor ────────────────────────────────────────────────────────
  r.post("/{id}/suspend")
    .summary("Suspend a vendor")
    .permission("marketplace:admin")
    .input(SuspendVendorBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof SuspendVendorBodySchema>;
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      const suspended = await services.vendor.suspend(params.id!, body.reason);
      if (!suspended) throw new Error("Vendor not found");
      return stripVendorSecrets(suspended);
    });

  // ─── Reinstate vendor ──────────────────────────────────────────────────────
  r.post("/{id}/reinstate")
    .summary("Reinstate a suspended vendor")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      const reinstated = await services.vendor.reinstate(params.id!);
      if (!reinstated) throw new Error("Vendor not found");
      return stripVendorSecrets(reinstated);
    });

  // ─── Upload vendor document ────────────────────────────────────────────────
  r.post("/{id}/documents")
    .summary("Upload a vendor document")
    .permission("marketplace:admin")
    .input(UploadDocumentBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof UploadDocumentBodySchema>;
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      return services.vendor.uploadDocument(params.id!, {
        type: body.type,
        fileUrl: body.fileUrl,
      });
    });

  // ─── List vendor documents ─────────────────────────────────────────────────
  r.get("/{id}/documents")
    .summary("List vendor documents")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      return services.vendor.listDocuments(params.id!);
    });

  // ─── Approve document ──────────────────────────────────────────────────────
  r.post("/{id}/documents/{docId}/approve")
    .summary("Approve a vendor document")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const updated = await services.vendor.approveDocument(params.docId!);
      if (!updated) throw new Error("Document not found");
      return updated;
    });

  // ─── Reject document ───────────────────────────────────────────────────────
  r.post("/{id}/documents/{docId}/reject")
    .summary("Reject a vendor document")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const updated = await services.vendor.rejectDocument(params.docId!);
      if (!updated) throw new Error("Document not found");
      return updated;
    });

  // ─── Vendor balance ────────────────────────────────────────────────────────
  r.get("/{id}/balance")
    .summary("Get vendor balance")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      const balance = await services.payout.getBalance(params.id!);
      const ledger = await services.payout.getLedger(params.id!);
      return { balanceCents: balance, ledger };
    });

  // ─── Vendor performance ────────────────────────────────────────────────────
  r.get("/{id}/performance")
    .summary("Get vendor performance metrics")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      const vendor = await services.vendor.getById(params.id!);
      if (!vendor) throw new Error("Vendor not found");
      const rating = await services.review.getAggregateRating(params.id!);
      const balance = await services.payout.getBalance(params.id!);
      return {
        vendorId: params.id!,
        performanceScore: vendor.performanceScore,
        tier: vendor.tier,
        rating,
        balanceCents: balance,
      };
    });

  return r.routes();
}
