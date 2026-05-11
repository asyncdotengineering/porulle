import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { z } from "@hono/zod-openapi";
import type { RFQService } from "../services/rfq.js";
import type { ContractPriceService } from "../services/contract-price.js";
import type { MarketplacePluginOptions } from "../types.js";
import {
  CreateRFQBodySchema,
  RespondRFQBodySchema,
  AwardRFQBodySchema,
  CreateContractPriceBodySchema,
  UpdateContractPriceBodySchema,
} from "../schemas/b2b.js";
import { stripUndefined } from "./util.js";

export function buildB2BRoutes(services: {
  rfq?: RFQService | undefined;
  contractPrice?: ContractPriceService | undefined;
}, options: MarketplacePluginOptions): PluginRouteRegistration[] {
  const allRoutes: PluginRouteRegistration[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // RFQ (Request for Quote)
  // ═══════════════════════════════════════════════════════════════════════════

  if (services.rfq) {
    const rfqSvc = services.rfq;
    const rfq = router("Marketplace - B2B", "/marketplace/rfq");

    rfq.post("/")
      .summary("Create a Request for Quote")
      .auth()
      .input(CreateRFQBodySchema)
      .handler(async ({ input }) => {
        const body = input as z.infer<typeof CreateRFQBodySchema>;
        return rfqSvc.create(stripUndefined({
          buyerId: body.buyerId,
          title: body.title,
          description: body.description,
          categorySlug: body.categorySlug,
          quantity: body.quantity,
          budgetCents: body.budgetCents,
          currency: body.currency,
          deadlineAt: body.deadlineAt ? new Date(body.deadlineAt) : undefined,
          metadata: body.metadata,
        }));
      });

    rfq.get("/")
      .summary("List Requests for Quote")
      .auth()
      .handler(async ({ query }) => {
        return rfqSvc.list(stripUndefined({
          status: query.status as string | undefined,
          categorySlug: query.categorySlug as string | undefined,
        }));
      });

    rfq.get("/{id}")
      .summary("Get RFQ detail")
      .auth()
      .handler(async ({ params }) => {
        const item = await rfqSvc.getById(params.id!);
        if (!item) throw new Error("RFQ not found");
        const responses = await rfqSvc.getResponses(item.id);
        return { ...item, responses };
      });

    rfq.post("/{id}/respond")
      .summary("Submit a vendor response to an RFQ")
      .auth()
      .input(RespondRFQBodySchema)
      .handler(async ({ params, input }) => {
        const body = input as z.infer<typeof RespondRFQBodySchema>;
        const item = await rfqSvc.getById(params.id!);
        if (!item) throw new Error("RFQ not found");
        return rfqSvc.respond(item.id, stripUndefined({
          vendorId: body.vendorId,
          unitPriceCents: body.unitPriceCents,
          totalPriceCents: body.totalPriceCents,
          leadTimeDays: body.leadTimeDays,
          notes: body.notes,
        }));
      });

    rfq.post("/{id}/award")
      .summary("Award an RFQ to a vendor")
      .auth()
      .permission("marketplace:admin")
      .input(AwardRFQBodySchema)
      .handler(async ({ params, input }) => {
        const body = input as z.infer<typeof AwardRFQBodySchema>;
        const updated = await rfqSvc.award(params.id!, body.vendorId);
        if (!updated) throw new Error("RFQ not found");
        return updated;
      });

    rfq.post("/{id}/close")
      .summary("Close an RFQ")
      .auth()
      .permission("marketplace:admin")
      .handler(async ({ params }) => {
        const updated = await rfqSvc.close(params.id!);
        if (!updated) throw new Error("RFQ not found");
        return updated;
      });

    allRoutes.push(...rfq.routes());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTRACT PRICES
  // ═══════════════════════════════════════════════════════════════════════════

  if (services.contractPrice) {
    const cpSvc = services.contractPrice;
    const cp = router("Marketplace - B2B", "/marketplace/contract-prices");

    cp.get("/")
      .summary("List contract prices")
      .auth()
      .handler(async ({ query }) => {
        return cpSvc.list(stripUndefined({
          vendorId: query.vendorId as string | undefined,
          buyerId: query.buyerId as string | undefined,
        }));
      });

    cp.post("/")
      .summary("Create a contract price")
      .auth()
      .permission("marketplace:admin")
      .input(CreateContractPriceBodySchema)
      .handler(async ({ input }) => {
        const body = input as z.infer<typeof CreateContractPriceBodySchema>;
        return cpSvc.create(stripUndefined({
          vendorId: body.vendorId,
          buyerId: body.buyerId,
          entityId: body.entityId,
          variantId: body.variantId,
          priceCents: body.priceCents,
          minQuantity: body.minQuantity,
          currency: body.currency,
          validFrom: body.validFrom ? new Date(body.validFrom) : undefined,
          validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
        }));
      });

    cp.patch("/{id}")
      .summary("Update a contract price")
      .auth()
      .permission("marketplace:admin")
      .input(UpdateContractPriceBodySchema)
      .handler(async ({ params, input }) => {
        const body = input as z.infer<typeof UpdateContractPriceBodySchema>;
        const updateData: Record<string, unknown> = {};
        if (body.priceCents !== undefined) updateData.priceCents = body.priceCents;
        if (body.minQuantity !== undefined) updateData.minQuantity = body.minQuantity;
        if (body.validFrom !== undefined) updateData.validFrom = body.validFrom ? new Date(body.validFrom) : null;
        if (body.validUntil !== undefined) updateData.validUntil = body.validUntil ? new Date(body.validUntil) : null;
        const updated = await cpSvc.update(params.id!, updateData);
        if (!updated) throw new Error("Contract price not found");
        return updated;
      });

    cp.delete("/{id}")
      .summary("Delete a contract price")
      .auth()
      .permission("marketplace:admin")
      .handler(async ({ params }) => {
        await cpSvc.delete(params.id!);
        return { deleted: true };
      });

    allRoutes.push(...cp.routes());
  }

  return allRoutes;
}
