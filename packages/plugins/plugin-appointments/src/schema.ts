import { boolean, integer, jsonb, pgTable, text, timestamp, uuid, index, uniqueIndex } from "@porulle/core/drizzle";

// ─── Service Types ──────────────────────────────────────────────────────────

export const serviceTypes = pgTable("appointment_service_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  priceCents: integer("price_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  mode: text("mode").notNull().default("in_person"), // in_person | online | hybrid
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
  maxAdvanceDays: integer("max_advance_days").notNull().default(60),
  minNoticeMins: integer("min_notice_mins").notNull().default(60),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgSlugUnique: uniqueIndex("apt_service_types_org_slug_unique").on(table.organizationId, table.slug),
  orgIdx: index("idx_apt_service_types_org").on(table.organizationId),
  slugIdx: index("idx_apt_service_types_slug").on(table.slug),
  activeIdx: index("idx_apt_service_types_active").on(table.isActive),
}));

// ─── Providers ──────────────────────────────────────────────────────────────

export const providers = pgTable("appointment_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id"), // Better Auth user ID (nullable for admin-created providers)
  name: text("name").notNull(),
  bio: text("bio"),
  email: text("email"),
  phone: text("phone"),
  timezone: text("timezone").notNull().default("UTC"),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index("idx_apt_providers_org").on(table.organizationId),
  activeIdx: index("idx_apt_providers_active").on(table.isActive),
}));

// ─── Provider–ServiceType Link ──────────────────────────────────────────────

export const providerServices = pgTable("appointment_provider_services", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").notNull(),
  serviceTypeId: uuid("service_type_id").notNull(),
  customDurationMinutes: integer("custom_duration_minutes"),
  customPriceCents: integer("custom_price_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerServiceIdx: uniqueIndex("idx_provider_service").on(table.providerId, table.serviceTypeId),
}));

// ─── Weekly Availability ────────────────────────────────────────────────────

export const weeklyAvailability = pgTable("appointment_weekly_availability", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").notNull(),
  dayOfWeek: integer("day_of_week").notNull(), // 0 = Sunday, 6 = Saturday
  startTime: text("start_time").notNull(), // "09:00" (HH:mm in provider's timezone)
  endTime: text("end_time").notNull(),     // "17:00"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerDayIdx: index("idx_weekly_provider_day").on(table.providerId, table.dayOfWeek),
}));

// ─── Availability Overrides (date-level) ────────────────────────────────────

export const availabilityOverrides = pgTable("appointment_availability_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").notNull(),
  date: text("date").notNull(), // "2026-03-25" (YYYY-MM-DD)
  isAvailable: boolean("is_available").notNull().default(true),
  startTime: text("start_time"), // null if isAvailable = false (day off)
  endTime: text("end_time"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerDateIdx: uniqueIndex("idx_override_provider_date").on(table.providerId, table.date),
}));

// ─── Breaks ─────────────────────────────────────────────────────────────────

export const breaks = pgTable("appointment_breaks", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").notNull(),
  dayOfWeek: integer("day_of_week"), // null = every day
  startTime: text("start_time").notNull(), // "12:00"
  endTime: text("end_time").notNull(),     // "13:00"
  label: text("label"), // "Lunch"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Bookings ───────────────────────────────────────────────────────────────

export const bookings = pgTable("appointment_bookings", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").notNull(),
  serviceTypeId: uuid("service_type_id").notNull(),
  customerId: text("customer_id").notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("provisional"),
  // provisional → confirmed → completed | cancelled | no_show
  paymentMethod: text("payment_method").notNull(), // "card" | "cash" | "invoice"
  notes: text("notes"),
  cancellationReason: text("cancellation_reason"),
  rescheduledFromId: uuid("rescheduled_from_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  providerTimeIdx: index("idx_apt_bookings_provider_time").on(table.providerId, table.startTime),
  customerIdx: index("idx_apt_bookings_customer").on(table.customerId),
  statusIdx: index("idx_apt_bookings_status").on(table.status),
  startTimeIdx: index("idx_apt_bookings_start_time").on(table.startTime),
}));

// ─── Booking Payments ───────────────────────────────────────────────────────

export const bookingPayments = pgTable("appointment_booking_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").notNull().unique(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("pending"), // pending | paid | refunded | failed
  paymentIntentId: text("payment_intent_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
