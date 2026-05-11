import { router, resolveOrgId } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ProviderService } from "../services/provider-service.js";
import { stripUndefined } from "./util.js";

const CreateServiceTypeSchema = z.object({
  name: z.string().min(1).openapi({ example: "Haircut" }),
  slug: z.string().min(1).openapi({ example: "haircut" }),
  description: z.string().optional(),
  durationMinutes: z.number().int().min(5).optional().openapi({ example: 30 }),
  priceCents: z.number().int().min(0).optional().openapi({ example: 3000 }),
  currency: z.string().optional().openapi({ example: "USD" }),
  bufferBeforeMinutes: z.number().int().min(0).optional(),
  bufferAfterMinutes: z.number().int().min(0).optional(),
}).openapi("CreateServiceTypeRequest");

const UpdateServiceTypeSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  durationMinutes: z.number().int().min(5).optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().optional(),
  bufferBeforeMinutes: z.number().int().min(0).optional(),
  bufferAfterMinutes: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
}).openapi("UpdateServiceTypeRequest");

export function buildServiceRoutes(services: {
  provider: ProviderService;
}): PluginRouteRegistration[] {
  const r = router("Appointments - Services", "/appointments/services");

  r.get("/")
    .summary("List service types")
    .handler(async () => {
      return services.provider.listServiceTypes();
    });

  r.post("/")
    .summary("Create service type")
    .permission("appointments:admin")
    .input(CreateServiceTypeSchema)
    .handler(async ({ input, actor }) => {
      const body = input as z.infer<typeof CreateServiceTypeSchema>;
      return services.provider.createServiceType(resolveOrgId(actor), stripUndefined(body));
    });

  r.get("/{id}")
    .summary("Get service type")
    .handler(async ({ params }) => {
      const svc = await services.provider.getServiceType(params.id!);
      if (!svc) throw new Error("Service type not found");
      return svc;
    });

  r.patch("/{id}")
    .summary("Update service type")
    .permission("appointments:admin")
    .input(UpdateServiceTypeSchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof UpdateServiceTypeSchema>;
      const updated = await services.provider.updateServiceType(params.id!, stripUndefined(body));
      if (!updated) throw new Error("Service type not found");
      return updated;
    });

  r.delete("/{id}")
    .summary("Delete service type")
    .permission("appointments:admin")
    .handler(async ({ params }) => {
      const deleted = await services.provider.deleteServiceType(params.id!);
      if (!deleted) throw new Error("Service type not found");
      return deleted;
    });

  return r.routes();
}
