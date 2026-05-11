import type { AnalyticsModel } from "@porulle/core";

export const APPOINTMENT_BOOKINGS_MODEL: AnalyticsModel = {
  name: "AppointmentBookings",
  table: "appointment_bookings",
  measures: {
    count: { type: "count" },
    revenue: { sql: "price_cents", type: "sum" },
    averagePrice: { sql: "price_cents", type: "avg" },
  },
  dimensions: {
    id: { sql: "id", type: "string" },
    providerId: { sql: "provider_id", type: "string" },
    serviceTypeId: { sql: "service_type_id", type: "string" },
    customerId: { sql: "customer_id", type: "string" },
    status: { sql: "status", type: "string" },
    paymentMethod: { sql: "payment_method", type: "string" },
    startTime: { sql: "start_time", type: "time" },
    createdAt: { sql: "created_at", type: "time" },
  },
  segments: {
    completed: { sql: "status = 'completed'" },
    cancelled: { sql: "status = 'cancelled'" },
    noShow: { sql: "status = 'no_show'" },
  },
};

export const APPOINTMENT_ANALYTICS_MODELS: AnalyticsModel[] = [
  APPOINTMENT_BOOKINGS_MODEL,
];
