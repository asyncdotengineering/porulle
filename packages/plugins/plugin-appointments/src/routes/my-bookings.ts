import { requireUserId, router } from "@porulle/core";
import type { CommerceConfig } from "@porulle/core";
import type { PluginRouteRegistration } from "@porulle/core";
import type { BookingService } from "../services/booking-service.js";

export function buildMyBookingRoutes(services: {
  booking: BookingService;
}, config: CommerceConfig): PluginRouteRegistration[] {
  const r = router("Appointments - My Bookings", "/appointments/my-bookings", { config });

  r.get("/")
    .summary("List my bookings")
    .auth()
    .handler(async ({ actor }) => {
      return services.booking.listByCustomer(requireUserId(actor));
    });

  r.get("/{id}")
    .summary("Get my booking")
    .auth()
    .handler(async ({ params, actor }) => {
      const booking = await services.booking.getById(params.id!);
      if (!booking) throw new Error("Booking not found");
      if (booking.customerId !== requireUserId(actor)) throw new Error("Booking not found");
      return booking;
    });

  return r.routes();
}
