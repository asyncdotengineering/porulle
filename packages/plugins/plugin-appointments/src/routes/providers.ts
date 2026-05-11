import { router, resolveOrgId } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ProviderService } from "../services/provider-service.js";
import { stripUndefined } from "./util.js";

const CreateProviderSchema = z.object({
  name: z.string().min(1).openapi({ example: "Jane Smith" }),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  timezone: z.string().optional().openapi({ example: "Asia/Colombo" }),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateProviderRequest");

const UpdateProviderSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  timezone: z.string().optional(),
  isActive: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("UpdateProviderRequest");

export function buildProviderRoutes(services: {
  provider: ProviderService;
}): PluginRouteRegistration[] {
  const r = router("Appointments - Providers", "/appointments/providers");

  r.get("/")
    .summary("List providers")
    .handler(async () => {
      return services.provider.listProviders();
    });

  r.post("/")
    .summary("Create provider")
    .permission("appointments:admin")
    .input(CreateProviderSchema)
    .handler(async ({ input, actor }) => {
      const body = input as z.infer<typeof CreateProviderSchema>;
      return services.provider.createProvider(resolveOrgId(actor), stripUndefined(body));
    });

  r.get("/{id}")
    .summary("Get provider")
    .handler(async ({ params }) => {
      const provider = await services.provider.getProvider(params.id!);
      if (!provider) throw new Error("Provider not found");
      return provider;
    });

  r.patch("/{id}")
    .summary("Update provider")
    .permission("appointments:admin")
    .input(UpdateProviderSchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof UpdateProviderSchema>;
      const updated = await services.provider.updateProvider(params.id!, stripUndefined(body));
      if (!updated) throw new Error("Provider not found");
      return updated;
    });

  r.delete("/{id}")
    .summary("Delete provider")
    .permission("appointments:admin")
    .handler(async ({ params }) => {
      const deleted = await services.provider.deleteProvider(params.id!);
      if (!deleted) throw new Error("Provider not found");
      return deleted;
    });

  // ─── Provider ↔ Service Links ───────────────────────────────────────────────

  r.post("/{id}/services")
    .summary("Link service type to provider")
    .permission("appointments:admin")
    .input(z.object({
      serviceTypeId: z.string().uuid().openapi({ example: "uuid" }),
      customDurationMinutes: z.number().int().min(5).optional(),
      customPriceCents: z.number().int().min(0).optional(),
    }).openapi("LinkProviderServiceRequest"))
    .handler(async ({ params, input }) => {
      const body = input as { serviceTypeId: string; customDurationMinutes?: number; customPriceCents?: number };
      return services.provider.linkServiceType(params.id!, body.serviceTypeId, stripUndefined({
        customDurationMinutes: body.customDurationMinutes,
        customPriceCents: body.customPriceCents,
      }));
    });

  r.get("/{id}/services")
    .summary("List provider's service types")
    .handler(async ({ params }) => {
      return services.provider.getProviderServices(params.id!);
    });

  return r.routes();
}
