import { defineCommercePlugin } from "@porulle/core";
import { APPOINTMENT_ANALYTICS_MODELS } from "./analytics-models.js";
import {
  serviceTypes, providers, providerServices,
  weeklyAvailability, availabilityOverrides, breaks,
  bookings, bookingPayments,
} from "./schema.js";
import { ProviderService } from "./services/provider-service.js";
import { SlotService } from "./services/slot-service.js";
import { BookingService } from "./services/booking-service.js";
import { buildHooks } from "./hooks.js";
import { buildServiceRoutes } from "./routes/services.js";
import { buildProviderRoutes } from "./routes/providers.js";
import { buildAvailabilityRoutes } from "./routes/availability.js";
import { buildBookingRoutes } from "./routes/bookings.js";
import { buildMyBookingRoutes } from "./routes/my-bookings.js";
import type { AppointmentPluginOptions, Db } from "./types.js";

export type { AppointmentPluginOptions } from "./types.js";
export { APPOINTMENT_EMAIL_TASKS } from "./tasks.js";

function createServices(db: Db, options: AppointmentPluginOptions, kernelServices?: Record<string, unknown>) {
  const provider = new ProviderService(db);
  const slots = new SlotService(db, {
    minNoticeMinutes: options.minNoticeMinutes ?? 0,
    maxAdvanceDays: options.maxAdvanceDays ?? 60,
  });
  // Wire jobs adapter from kernel services so BookingService can enqueue notifications
  const jobs = kernelServices?.jobs as import("@porulle/core").JobsAdapter | undefined;
  const booking = new BookingService(db, slots, undefined, jobs);
  return { provider, slots, booking };
}

export function appointmentPlugin(options: AppointmentPluginOptions = {}) {
  return defineCommercePlugin({
    id: "appointments",
    version: "1.0.0",

    permissions: [
      { scope: "appointments:admin", description: "Full appointment administration (services, providers)" },
      { scope: "appointments:manage", description: "Manage bookings and availability (for providers)" },
      { scope: "appointments:book", description: "Create and manage own bookings (for customers)" },
    ],

    schema: () => ({
      serviceTypes,
      providers,
      providerServices,
      weeklyAvailability,
      availabilityOverrides,
      breaks,
      bookings,
      bookingPayments,
    }),

    hooks: () => buildHooks(options),

    routes: (ctx) => {
      const db = ctx.database.db as Db;
      const services = db ? createServices(db, options, ctx.services) : null;
      if (!services) return [];

      return [
        ...buildServiceRoutes(services),
        ...buildProviderRoutes(services),
        ...buildAvailabilityRoutes(services),
        ...buildBookingRoutes(services),
        ...buildMyBookingRoutes(services),
      ];
    },

    analyticsModels: () => APPOINTMENT_ANALYTICS_MODELS,
  });
}
