import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import { z } from "@hono/zod-openapi";
import type { BookingService } from "../services/booking-service.js";
import type { ProviderService } from "../services/provider-service.js";
import type { BookingStatus } from "../types.js";

const CreateBookingSchema = z.object({
  providerId: z.string().uuid(),
  serviceTypeId: z.string().uuid(),
  startTime: z.string().datetime().openapi({ example: "2026-03-20T09:00:00Z" }),
  customerName: z.string().min(1).openapi({ example: "John Doe" }),
  customerEmail: z.string().email().openapi({ example: "john@example.com" }),
  customerPhone: z.string().optional(),
  paymentMethod: z.enum(["card", "cash", "invoice"]).openapi({ example: "cash" }),
  notes: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).openapi("CreateBookingRequest");

const RescheduleBookingSchema = z.object({
  newStartTime: z.string().datetime().openapi({ example: "2026-03-21T10:00:00Z" }),
}).openapi("RescheduleBookingRequest");

const CancelBookingSchema = z.object({
  reason: z.string().optional(),
}).openapi("CancelBookingRequest");

export function buildBookingRoutes(services: {
  booking: BookingService;
  provider: ProviderService;
}): PluginRouteRegistration[] {
  const r = router("Appointments - Bookings", "/appointments/bookings");

  r.get("/")
    .summary("List bookings")
    .permission("appointments:manage")
    .query(z.object({
      providerId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
    }))
    .handler(async ({ query }) => {
      const providerId = query.providerId as string | undefined;
      if (!providerId) throw new Error("providerId is required");
      return services.booking.listByProvider(
        providerId,
        query.from ? new Date(query.from as string) : undefined,
        query.to ? new Date(query.to as string) : undefined,
      );
    });

  r.post("/")
    .summary("Create booking")
    .auth()
    .input(CreateBookingSchema)
    .handler(async ({ input, actor }) => {
      const body = input as z.infer<typeof CreateBookingSchema>;
      const result = await services.booking.create({
        providerId: body.providerId,
        serviceTypeId: body.serviceTypeId,
        customerId: actor!.userId,
        customerName: body.customerName,
        customerEmail: body.customerEmail,
        customerPhone: body.customerPhone,
        startTime: new Date(body.startTime),
        paymentMethod: body.paymentMethod,
        notes: body.notes,
        metadata: body.metadata,
      });

      if (!result.ok) {
        const status = result.code === "CONFLICT" ? 409 : result.code === "NOT_FOUND" ? 404 : 400;
        throw Object.assign(new Error(result.error), { statusCode: status });
      }

      return {
        booking: result.booking,
        ...(result.paymentIntent ? { paymentIntent: result.paymentIntent } : {}),
      };
    });

  r.get("/{id}")
    .summary("Get booking")
    .permission("appointments:manage")
    .handler(async ({ params }) => {
      const booking = await services.booking.getById(params.id!);
      if (!booking) throw new Error("Booking not found");
      return booking;
    });

  r.post("/{id}/confirm")
    .summary("Confirm booking")
    .permission("appointments:manage")
    .handler(async ({ params }) => {
      const result = await services.booking.changeStatus(params.id!, "confirmed");
      if (!result.ok) throw new Error(result.error);
      return result.booking;
    });

  r.post("/{id}/complete")
    .summary("Complete appointment")
    .permission("appointments:manage")
    .handler(async ({ params }) => {
      const result = await services.booking.complete(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.booking;
    });

  r.post("/{id}/no-show")
    .summary("Mark as no-show")
    .permission("appointments:manage")
    .handler(async ({ params }) => {
      const result = await services.booking.markNoShow(params.id!);
      if (!result.ok) throw new Error(result.error);
      return result.booking;
    });

  r.post("/{id}/cancel")
    .summary("Cancel booking")
    .auth()
    .input(CancelBookingSchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof CancelBookingSchema>;
      const result = await services.booking.cancel(params.id!, body.reason);
      if (!result.ok) throw new Error(result.error);
      return { booking: result.booking, refunded: result.refunded };
    });

  r.post("/{id}/reschedule")
    .summary("Reschedule booking")
    .auth()
    .input(RescheduleBookingSchema)
    .handler(async ({ params, input }) => {
      const body = input as z.infer<typeof RescheduleBookingSchema>;
      const result = await services.booking.reschedule(params.id!, new Date(body.newStartTime));
      if (!result.ok) throw new Error(result.error);
      return { oldBooking: result.oldBooking, newBooking: result.newBooking };
    });

  return r.routes();
}
