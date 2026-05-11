import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { ProviderService } from "../services/provider-service.js";
import type { SlotService } from "../services/slot-service.js";

const WeeklyScheduleSchema = z.object({
  schedules: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: "09:00" }),
    endTime: z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: "17:00" }),
  })),
}).openapi("SetWeeklyAvailabilityRequest");

const AddBreakSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: "12:00" }),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).openapi({ example: "13:00" }),
  label: z.string().optional().openapi({ example: "Lunch" }),
}).openapi("AddBreakRequest");

const AddOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: "2026-12-25" }),
  isAvailable: z.boolean(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  reason: z.string().optional().openapi({ example: "Christmas Day" }),
}).openapi("AddOverrideRequest");

export function buildAvailabilityRoutes(services: {
  provider: ProviderService;
  slots: SlotService;
}): PluginRouteRegistration[] {
  const r = router("Appointments - Availability", "/appointments/availability");

  // ─── Weekly Schedule ────────────────────────────────────────────────────────

  r.put("/{providerId}/weekly")
    .summary("Set weekly availability")
    .permission("appointments:manage")
    .input(WeeklyScheduleSchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof WeeklyScheduleSchema>;
      return services.provider.setWeeklyAvailability(params.providerId!, body.schedules);
    });

  r.get("/{providerId}/weekly")
    .summary("Get weekly availability")
    .handler(async ({ params }) => {
      return services.provider.getWeeklyAvailability(params.providerId!);
    });

  // ─── Breaks ─────────────────────────────────────────────────────────────────

  r.post("/{providerId}/breaks")
    .summary("Add break")
    .permission("appointments:manage")
    .input(AddBreakSchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof AddBreakSchema>;
      return services.provider.addBreak(params.providerId!, body);
    });

  r.get("/{providerId}/breaks")
    .summary("List breaks")
    .handler(async ({ params }) => {
      return services.provider.getBreaks(params.providerId!);
    });

  r.delete("/{providerId}/breaks/{breakId}")
    .summary("Delete break")
    .permission("appointments:manage")
    .handler(async ({ params }) => {
      const deleted = await services.provider.deleteBreak(params.breakId!);
      if (!deleted) throw new Error("Break not found");
      return deleted;
    });

  // ─── Overrides ──────────────────────────────────────────────────────────────

  r.post("/{providerId}/overrides")
    .summary("Add date override")
    .permission("appointments:manage")
    .input(AddOverrideSchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof AddOverrideSchema>;
      return services.provider.addOverride(params.providerId!, body);
    });

  r.get("/{providerId}/overrides")
    .summary("List overrides")
    .handler(async ({ params }) => {
      return services.provider.getOverrides(params.providerId!);
    });

  r.delete("/{providerId}/overrides/{overrideId}")
    .summary("Delete override")
    .permission("appointments:manage")
    .handler(async ({ params }) => {
      const deleted = await services.provider.deleteOverride(params.overrideId!);
      if (!deleted) throw new Error("Override not found");
      return deleted;
    });

  // ─── Available Slots ────────────────────────────────────────────────────────

  r.get("/{providerId}/slots")
    .summary("Get available slots for a date")
    .query(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: "2026-03-20" }),
      serviceTypeId: z.string().uuid(),
    }))
    .handler(async ({ params, query }) => {
      const providerId = params.providerId!;
      const dateStr = query.date as string;
      const serviceTypeId = query.serviceTypeId as string;

      const provider = await services.provider.getProvider(providerId);
      if (!provider) throw new Error("Provider not found");

      const serviceType = await services.provider.getServiceType(serviceTypeId);
      if (!serviceType) throw new Error("Service type not found");

      // Check for provider-level custom duration/price
      const providerSvcs = await services.provider.getProviderServices(providerId);
      const link = providerSvcs.find((ps) => ps.serviceTypeId === serviceTypeId);

      const durationMinutes = link?.customDurationMinutes ?? serviceType.durationMinutes;
      const bufferBefore = serviceType.bufferBeforeMinutes;
      const bufferAfter = serviceType.bufferAfterMinutes;

      // Parse date (in provider's local context)
      const [year, month, day] = dateStr.split("-").map(Number);
      const date = new Date(year!, month! - 1, day!);

      const slots = await services.slots.getAvailableSlots(
        providerId,
        serviceTypeId,
        date,
        durationMinutes,
        bufferBefore,
        bufferAfter,
        provider.timezone,
      );

      return slots.map((s) => ({
        start: s.start.toISOString(),
        end: s.end.toISOString(),
      }));
    });

  return r.routes();
}
