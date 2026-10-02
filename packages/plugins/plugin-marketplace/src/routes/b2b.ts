import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { z } from "@hono/zod-openapi";
import type { RFQService } from "../services/rfq.js";
import type { MarketplacePluginOptions } from "../types.js";
import {
  CreateRFQBodySchema,
  RespondRFQBodySchema,
  AwardRFQBodySchema,
} from "../schemas/b2b.js";
import { stripUndefined } from "./util.js";

export function buildB2BRoutes(services: {
  rfq?: RFQService | undefined;
}, _options: MarketplacePluginOptions): PluginRouteRegistration[] {
  const allRoutes: PluginRouteRegistration[] = [];

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

  return allRoutes;
}
