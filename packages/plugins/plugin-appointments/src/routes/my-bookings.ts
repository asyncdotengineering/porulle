import { router } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { BookingService } from "../services/booking-service.js";

export function buildMyBookingRoutes(services: {
  booking: BookingService;
}): PluginRouteRegistration[] {
  const r = router("Appointments - My Bookings", "/appointments/my-bookings");

  r.get("/")
    .summary("List my bookings")
    .auth()
    .handler(async ({ actor }) => {
      return services.booking.listByCustomer(actor!.userId);
    });

  r.get("/{id}")
    .summary("Get my booking")
    .auth()
    .handler(async ({ params, actor }) => {
      const booking = await services.booking.getById(params.id!);
      if (!booking) throw new Error("Booking not found");
      if (booking.customerId !== actor!.userId) throw new Error("Booking not found");
      return booking;
    });

  return r.routes();
}
