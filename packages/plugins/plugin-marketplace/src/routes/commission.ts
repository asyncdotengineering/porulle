import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { z } from "@hono/zod-openapi";
import type { CommissionService } from "../services/commission.js";
import {
  CreateCommissionRuleBodySchema,
  UpdateCommissionRuleBodySchema,
  PreviewCommissionBodySchema,
} from "../schemas/commission.js";
import { stripUndefined } from "./util.js";

export function buildCommissionRoutes(services: {
  commission: CommissionService;
}): PluginRouteRegistration[] {
  const r = router("Marketplace - Commission", "/marketplace/commission-rules");

  // ─── List commission rules ─────────────────────────────────────────────────
  r.get("/")
    .summary("List all commission rules")
    .permission("marketplace:admin")
    .handler(async () => {
      return services.commission.listRules();
    });

  // ─── Create commission rule ────────────────────────────────────────────────
  r.post("/")
    .summary("Create a commission rule")
    .permission("marketplace:admin")
    .input(CreateCommissionRuleBodySchema)
    .handler(async ({ input }) => {
      const body = input as z.infer<typeof CreateCommissionRuleBodySchema>;
      return services.commission.createRule(stripUndefined({
        name: body.name,
        type: body.type,
        rateBps: body.rateBps,
        categorySlug: body.categorySlug,
        vendorId: body.vendorId,
        vendorTier: body.vendorTier,
        minVolumeCents: body.minVolumeCents,
        maxVolumeCents: body.maxVolumeCents,
        validFrom: body.validFrom ? new Date(body.validFrom) : undefined,
        validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
        priority: body.priority,
      }));
    });

  // ─── Update commission rule ────────────────────────────────────────────────
  r.patch("/{id}")
    .summary("Update a commission rule")
    .permission("marketplace:admin")
    .input(UpdateCommissionRuleBodySchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof UpdateCommissionRuleBodySchema>;
      const updateData: Record<string, unknown> = {};
      if (body.name !== undefined) updateData.name = body.name;
      if (body.rateBps !== undefined) updateData.rateBps = body.rateBps;
      if (body.categorySlug !== undefined) updateData.categorySlug = body.categorySlug;
      if (body.vendorTier !== undefined) updateData.vendorTier = body.vendorTier;
      if (body.minVolumeCents !== undefined) updateData.minVolumeCents = body.minVolumeCents;
      if (body.maxVolumeCents !== undefined) updateData.maxVolumeCents = body.maxVolumeCents;
      if (body.validFrom !== undefined) updateData.validFrom = body.validFrom ? new Date(body.validFrom) : null;
      if (body.validUntil !== undefined) updateData.validUntil = body.validUntil ? new Date(body.validUntil) : null;
      if (body.priority !== undefined) updateData.priority = body.priority;
      if (body.isActive !== undefined) updateData.isActive = body.isActive;

      const updated = await services.commission.updateRule(params.id!, updateData);
      if (!updated) throw new Error("Commission rule not found");
      return updated;
    });

  // ─── Delete commission rule ────────────────────────────────────────────────
  r.delete("/{id}")
    .summary("Delete a commission rule")
    .permission("marketplace:admin")
    .handler(async ({ params }) => {
      await services.commission.deleteRule(params.id!);
      return { deleted: true };
    });

  // ─── Preview commission rate ───────────────────────────────────────────────
  r.post("/preview")
    .summary("Preview the commission rate for a vendor")
    .permission("marketplace:admin")
    .input(PreviewCommissionBodySchema)
    .handler(async ({ input }) => {
      const body = input as z.infer<typeof PreviewCommissionBodySchema>;
      return services.commission.previewRate(
        body.vendorId,
        body.categorySlug,
        body.volumeCents,
      );
    });

  return r.routes();
}
