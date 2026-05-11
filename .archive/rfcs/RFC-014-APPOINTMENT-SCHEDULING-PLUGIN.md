# RFC-014: Appointment Scheduling Plugin

- **Status:** Complete
- **Author:** Engineering
- **Date:** 2026-03-16
- **Scope:** `packages/plugins/plugin-appointments/`
- **Reference:** https://github.com/tyannaavory21/appointment-scheduling-system (cloned to `about-appointment/`)
- **Studied:** Cal.com (open-source scheduling), Calendly (slot generation), Acuity Scheduling (buffer times)
- **Estimated effort:** 10-12 engineering-days
- **Priority:** High — appointment-based commerce (salons, clinics, consultants, fitness studios) is a $350B market

---

## 1. Problem

The reference appointment system (`about-appointment/backend/`) is an Express.js MVP with significant production gaps:

- No auth enforcement on any route (all endpoints are public)
- No RBAC (roles defined but unchecked)
- Slot generation ignores breaks, holidays, and buffer times
- Payment flow incomplete (no webhooks, refunds, auto-cancellation)
- Email notifications configured but never called
- Job queues created but never populated
- No double-booking prevention (race conditions on slot selection)
- No input validation
- Timezone handling partially implemented

We need to rebuild this as a **UnifiedCommerce plugin** that leverages our existing infrastructure: Better Auth, `router()` builder, job queue, Stripe adapter, OpenAPI spec, Pino logging, permission scopes, and Drizzle ORM.

---

## 2. What the Plugin Delivers

An appointment scheduling system for service-based commerce: salons, clinics, consultants, fitness studios, legal practices, home services.

**Core capabilities:**
- Provider availability management (recurring weekly + exceptions)
- Intelligent slot generation (respects breaks, holidays, buffer times, timezone)
- Double-booking prevention via `SELECT FOR UPDATE` (same pattern as inventory)
- Multi-step booking flow: browse slots -> reserve (10 min hold) -> pay -> confirm
- Payment: pay-at-booking (Stripe) or pay-at-service (cash/invoice)
- Notifications: booking confirmation, reminders (24h, 1h), cancellation, rescheduling
- Auto-cancellation of unpaid provisional bookings (via job queue)
- Client self-service: view/cancel/reschedule own appointments
- Provider dashboard: view schedule, mark complete/no-show
- Admin: manage providers, service types, analytics

---

## 3. Database Schema

### Tables (8 new tables, Drizzle `pgTable`)

```
appointment_service_types      — what can be booked (Consultation, Haircut, etc.)
appointment_providers          — who provides the service (linked to Better Auth user)
appointment_availability       — recurring weekly schedule (Mon 9-5, Tue 10-6, etc.)
appointment_availability_overrides — date-specific exceptions (off Dec 25, working Sunday Jan 5)
appointment_breaks             — break periods within availability (lunch 12-1)
appointment_bookings           — the actual appointments (customer + provider + timeslot)
appointment_booking_payments   — payment records (linked to core payment adapter)
appointment_reminders          — scheduled reminder jobs (24h, 1h before)
```

### Schema Definitions

```typescript
// appointment_service_types — what services are bookable
export const appointmentServiceTypes = pgTable("appointment_service_types", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),                    // "60-min Consultation"
  slug: text("slug").notNull().unique(),           // "60-min-consultation"
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull(), // 60
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),  // 15 min prep
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),   // 15 min cleanup
  priceCents: integer("price_cents").notNull(),    // 9900 = $99.00
  currency: text("currency").notNull().default("USD"),
  mode: text("mode", { enum: ["in_person", "online", "hybrid"] }).notNull().default("in_person"),
  maxAdvanceDays: integer("max_advance_days").notNull().default(60),    // bookable 60 days ahead
  minNoticeMins: integer("min_notice_mins").notNull().default(60),     // must book 1h+ in advance
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_apt_service_types_slug").on(table.slug),
  index("idx_apt_service_types_active").on(table.isActive),
]);

// appointment_providers — who provides the service
export const appointmentProviders = pgTable("appointment_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().unique(),      // Better Auth user ID
  displayName: text("display_name").notNull(),
  bio: text("bio"),
  timezone: text("timezone").notNull().default("UTC"),  // IANA timezone
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_apt_providers_user_id").on(table.userId),
  index("idx_apt_providers_active").on(table.isActive),
]);

// appointment_availability — recurring weekly schedule
export const appointmentAvailability = pgTable("appointment_availability", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").references(() => appointmentProviders.id, { onDelete: "cascade" }).notNull(),
  dayOfWeek: integer("day_of_week").notNull(),     // 0=Sunday, 6=Saturday
  startTime: text("start_time").notNull(),          // "09:00" (HH:MM in provider timezone)
  endTime: text("end_time").notNull(),              // "17:00"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_apt_availability_provider").on(table.providerId),
]);

// appointment_availability_overrides — date-specific exceptions
export const appointmentAvailabilityOverrides = pgTable("appointment_availability_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  providerId: uuid("provider_id").references(() => appointmentProviders.id, { onDelete: "cascade" }).notNull(),
  date: text("date").notNull(),                     // "2026-12-25" (ISO date)
  isAvailable: boolean("is_available").notNull(),   // false = day off, true = working override
  startTime: text("start_time"),                    // null if isAvailable=false, "10:00" if working
  endTime: text("end_time"),                        // null if isAvailable=false, "14:00" if working
  reason: text("reason"),                           // "Christmas", "Special Saturday hours"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_apt_overrides_provider_date").on(table.providerId, table.date),
]);

// appointment_breaks — break periods within availability
export const appointmentBreaks = pgTable("appointment_breaks", {
  id: uuid("id").defaultRandom().primaryKey(),
  availabilityId: uuid("availability_id").references(() => appointmentAvailability.id, { onDelete: "cascade" }).notNull(),
  startTime: text("start_time").notNull(),          // "12:00"
  endTime: text("end_time").notNull(),              // "13:00"
});

// appointment_bookings — the actual appointments
export const appointmentBookings = pgTable("appointment_bookings", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceTypeId: uuid("service_type_id").references(() => appointmentServiceTypes.id).notNull(),
  providerId: uuid("provider_id").references(() => appointmentProviders.id).notNull(),
  customerId: uuid("customer_id"),                  // links to customers table (nullable for guest booking)
  customerEmail: text("customer_email").notNull(),
  customerName: text("customer_name").notNull(),
  status: text("status", {
    enum: ["provisional", "confirmed", "rescheduled", "cancelled", "completed", "no_show"],
  }).notNull().default("provisional"),
  startTime: timestamp("start_time", { withTimezone: true }).notNull(),
  endTime: timestamp("end_time", { withTimezone: true }).notNull(),
  paymentMethod: text("payment_method", { enum: ["card", "cash", "invoice"] }).notNull(),
  notes: text("notes"),
  cancellationReason: text("cancellation_reason"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_apt_bookings_provider_time").on(table.providerId, table.startTime),
  index("idx_apt_bookings_customer").on(table.customerId),
  index("idx_apt_bookings_status").on(table.status),
  index("idx_apt_bookings_start_time").on(table.startTime),
]);

// appointment_booking_payments — payment linked to booking
export const appointmentBookingPayments = pgTable("appointment_booking_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookingId: uuid("booking_id").references(() => appointmentBookings.id, { onDelete: "cascade" }).notNull().unique(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  status: text("status", { enum: ["pending", "paid", "refunded", "failed"] }).notNull().default("pending"),
  paymentIntentId: text("payment_intent_id"),       // Stripe PaymentIntent ID
  paidAt: timestamp("paid_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

---

## 4. Slot Generation Algorithm

The core intellectual property of any scheduling system. Here's how slots are computed:

**Pseudocode:**

```
FUNCTION getAvailableSlots(providerId, date, serviceTypeId):
    provider = GET provider with timezone
    serviceType = GET service type with duration + buffers

    // 1. Determine working hours for this date
    override = FIND override for provider + date
    IF override EXISTS AND override.isAvailable == false:
        RETURN []  // day off

    IF override EXISTS AND override.isAvailable == true:
        workStart = override.startTime
        workEnd = override.endTime
    ELSE:
        dayOfWeek = date.dayOfWeek (0-6)
        availability = FIND availability for provider + dayOfWeek
        IF NOT availability:
            RETURN []  // provider doesn't work this day
        workStart = availability.startTime
        workEnd = availability.endTime

    // 2. Get breaks for this availability
    breaks = FIND breaks for availability

    // 3. Generate candidate slots
    totalDuration = serviceType.bufferBefore + serviceType.duration + serviceType.bufferAfter
    slots = []
    cursor = workStart
    WHILE cursor + totalDuration <= workEnd:
        slotStart = cursor + serviceType.bufferBefore
        slotEnd = slotStart + serviceType.duration
        slots.push({ start: slotStart, end: slotEnd, bufferStart: cursor, bufferEnd: slotEnd + serviceType.bufferAfter })
        cursor = cursor + serviceType.duration  // or configurable step interval

    // 4. Subtract breaks
    slots = slots.filter(slot => NOT overlaps(slot, breaks))

    // 5. Subtract existing bookings (including buffer zones)
    existingBookings = SELECT FROM appointment_bookings
        WHERE providerId = provider.id
        AND startTime >= date.startOfDay
        AND startTime < date.endOfDay
        AND status NOT IN ('cancelled')

    slots = slots.filter(slot => NOT overlaps(slot.bufferStart..slot.bufferEnd, existingBookings))

    // 6. Apply min notice (can't book slot that starts in < minNoticeMins)
    now = NOW()
    slots = slots.filter(slot => slot.start > now + serviceType.minNoticeMins)

    // 7. Apply max advance (can't book too far in the future)
    slots = slots.filter(slot => slot.start < now + serviceType.maxAdvanceDays)

    // 8. Convert times from provider timezone to UTC
    RETURN slots.map(convertToUTC(provider.timezone))
```

### Double-Booking Prevention

Same pattern as inventory reservation — `SELECT FOR UPDATE`:

```typescript
// Inside a transaction:
const existingBooking = await tx
  .select()
  .from(appointmentBookings)
  .where(and(
    eq(appointmentBookings.providerId, providerId),
    gte(appointmentBookings.startTime, slotStart),
    lt(appointmentBookings.startTime, slotEnd),
    ne(appointmentBookings.status, "cancelled"),
  ))
  .for("update")  // lock the rows
  .limit(1);

if (existingBooking.length > 0) {
  throw new CommerceConflictError("This slot is no longer available.");
}

// Create booking within the same transaction
await tx.insert(appointmentBookings).values({ ... });
```

### Provisional Hold (Redis-backed)

When a customer selects a slot and enters payment details:

```
FUNCTION holdSlot(providerId, slotTime, customerId):
    key = "apt:hold:{providerId}:{slotTime}"
    existing = REDIS.GET(key)
    IF existing AND existing != customerId:
        THROW "Slot is being held by another customer"
    REDIS.SET(key, customerId, TTL=600)  // 10 minute hold
```

---

## 5. API Endpoints (using `router()` builder)

```typescript
const services = router("Appointment Services", "/appointments/services");
const providers = router("Appointment Providers", "/appointments/providers");
const availability = router("Appointment Availability", "/appointments/availability");
const bookings = router("Appointment Bookings", "/appointments/bookings");
const myBookings = router("My Appointments", "/appointments/me");

// ─── Service Types ───────────────────────────────────────────────────
services.get("/").summary("List active service types").handler(...)
services.get("/{idOrSlug}").summary("Get service type").handler(...)
services.post("/").summary("Create service type").permission("appointments:admin").input(CreateServiceTypeSchema).handler(...)
services.patch("/{id}").summary("Update service type").permission("appointments:admin").input(UpdateServiceTypeSchema).handler(...)
services.delete("/{id}").summary("Deactivate service type").permission("appointments:admin").handler(...)

// ─── Providers ───────────────────────────────────────────────────────
providers.get("/").summary("List active providers").handler(...)
providers.get("/{id}").summary("Get provider profile").handler(...)
providers.post("/").summary("Register as provider").permission("appointments:admin").input(CreateProviderSchema).handler(...)
providers.patch("/{id}").summary("Update provider profile").permission("appointments:admin").input(UpdateProviderSchema).handler(...)

// ─── Availability ────────────────────────────────────────────────────
availability.get("/{providerId}").summary("Get provider weekly schedule").handler(...)
availability.post("/{providerId}").summary("Set weekly availability").permission("appointments:manage").input(SetAvailabilitySchema).handler(...)
availability.post("/{providerId}/overrides").summary("Add date override").permission("appointments:manage").input(AddOverrideSchema).handler(...)
availability.post("/{providerId}/breaks").summary("Add break period").permission("appointments:manage").input(AddBreakSchema).handler(...)
availability.get("/{providerId}/slots").summary("Get available slots for a date").query(SlotQuerySchema).handler(...)  // THE KEY ENDPOINT

// ─── Bookings ────────────────────────────────────────────────────────
bookings.post("/").summary("Create booking").auth().input(CreateBookingSchema).handler(...)  // reservation + payment
bookings.get("/").summary("List bookings").permission("appointments:admin").handler(...)
bookings.get("/{id}").summary("Get booking").auth().handler(...)
bookings.post("/{id}/confirm").summary("Confirm booking").permission("appointments:manage").handler(...)
bookings.post("/{id}/cancel").summary("Cancel booking").auth().input(CancelBookingSchema).handler(...)
bookings.post("/{id}/reschedule").summary("Reschedule booking").auth().input(RescheduleSchema).handler(...)
bookings.post("/{id}/complete").summary("Mark as completed").permission("appointments:manage").handler(...)
bookings.post("/{id}/no-show").summary("Mark as no-show").permission("appointments:manage").handler(...)

// ─── Customer Self-Service ───────────────────────────────────────────
myBookings.get("/").summary("List my upcoming bookings").auth().handler(...)
myBookings.get("/{id}").summary("Get my booking detail").auth().handler(...)
myBookings.post("/{id}/cancel").summary("Cancel my booking").auth().input(CancelBookingSchema).handler(...)
myBookings.post("/{id}/reschedule").summary("Reschedule my booking").auth().input(RescheduleSchema).handler(...)
```

**Total: ~25 routes across 5 route groups.**

---

## 6. Integration with Existing Infrastructure

| Concern | UnifiedCommerce Feature | How It's Used |
|---------|------------------------|---------------|
| Authentication | Better Auth (session + API key) | `router().auth()` on all booking routes |
| Authorization | Plugin permission scopes | `appointments:admin`, `appointments:manage` |
| Payments | Core `PaymentAdapter` (Stripe) | `createPaymentIntent` for card bookings |
| Job Queue | Core `commerce_jobs` table | Reminder scheduling, auto-cancellation |
| Webhooks | Core webhook system | `booking.created`, `booking.cancelled`, `booking.reminded` events |
| Audit Log | Core audit system | All booking state changes logged |
| Customers | Core `customers` table | Link bookings to customer profiles |
| OpenAPI | `router()` builder | All routes auto-documented in `/api/doc` |
| Rate Limiting | Core rate limiter | Slot queries rate-limited to prevent scraping |
| Analytics | `analyticsModels` manifest | Bookings cube (count, revenue, no-show rate) |

---

## 7. Notification Strategy

Using the existing job queue (`commerce_jobs`):

| Event | When | Channel | Template |
|-------|------|---------|----------|
| Booking confirmed | After payment captured | Email | "Your appointment with {provider} on {date} at {time} is confirmed" |
| Reminder (24h) | 24 hours before appointment | Email | "Reminder: your appointment is tomorrow at {time}" |
| Reminder (1h) | 1 hour before appointment | Email | "Your appointment with {provider} starts in 1 hour" |
| Booking cancelled | On cancellation | Email | "Your appointment on {date} has been cancelled" |
| Booking rescheduled | On reschedule | Email | "Your appointment has been moved to {newDate} at {newTime}" |
| Provider notification | On new booking | Email | "{customer} booked a {serviceType} on {date} at {time}" |
| No-show | When marked no-show | Email | "You missed your appointment. Contact us to rebook." |
| Auto-cancellation | 24h before unpaid provisional | Email | "Your provisional booking was cancelled (unpaid)" |

Reminders scheduled via `ctx.jobs.enqueue("appointments/remind", { bookingId }, { runAt: startTime - 24h })`.

---

## 8. Permission Scopes

```typescript
permissions: [
  { scope: "appointments:admin", description: "Full appointment management (CRUD service types, providers)" },
  { scope: "appointments:manage", description: "Manage bookings and availability (for providers)" },
  { scope: "appointments:book", description: "Create and manage own bookings (for customers)" },
],
```

---

## 9. What We Fix from the Reference System

| Gap in Reference | Our Fix |
|------------------|---------|
| No auth enforcement | `router().auth()` and `.permission()` on every route |
| No RBAC | Plugin permission scopes (admin/manage/book) |
| Slot generation ignores breaks | Algorithm step 4 subtracts breaks |
| Slot generation ignores holidays | Algorithm step 1 checks overrides first |
| No buffer time between appointments | `bufferBeforeMinutes` + `bufferAfterMinutes` on service type |
| No min notice period | `minNoticeMins` — can't book less than 1h in advance |
| No max advance booking | `maxAdvanceDays` — can't book more than 60 days ahead |
| No double-booking prevention | `SELECT FOR UPDATE` in transaction (same as inventory) |
| No provisional hold during checkout | Redis-backed 10-minute slot hold |
| Payment flow incomplete | Uses core `PaymentAdapter` (Stripe with webhook support) |
| No refund on cancellation | Cancellation triggers `refundPayment()` via adapter |
| Auto-cancellation not implemented | Job queue: enqueue cancellation 24h before unpaid provisional |
| Email notifications configured but never called | Job queue: enqueue notifications on every state change |
| Reminders not implemented | Job queue: schedule 24h and 1h reminders on booking creation |
| No input validation | Zod schemas via `router().input()` |
| Timezone handling incomplete | Provider stores IANA timezone, all slot generation in provider TZ, storage in UTC |
| No audit trail | Core audit system hooks on all state changes |
| No analytics | `appointmentBookingsCube` registered via `analyticsModels` |
| Tests are stubs | Full E2E test suite using `router()` pattern |

---

## 10. Implementation Order

| Phase | What | Effort |
|-------|------|--------|
| 1 | Schema + service types + providers CRUD | 1 day |
| 2 | Availability management (weekly + overrides + breaks) | 1.5 days |
| 3 | Slot generation algorithm + tests | 2 days |
| 4 | Booking flow (reserve → pay → confirm) with double-booking prevention | 2 days |
| 5 | Cancellation + rescheduling + refunds | 1 day |
| 6 | Notifications + reminders via job queue | 1 day |
| 7 | Customer self-service routes | 0.5 days |
| 8 | Analytics model + admin dashboard routes | 0.5 days |
| 9 | E2E tests (slot generation, booking flow, cancellation, timezone) | 1.5 days |
| 10 | Documentation | 0.5 days |

---

## 11. Success Criteria

- [ ] 8 Drizzle tables with proper indexes
- [ ] Slot generation respects: availability, breaks, overrides, buffers, min notice, max advance
- [ ] Double-booking prevented via `SELECT FOR UPDATE`
- [ ] Provisional hold via Redis (10 min TTL)
- [ ] Payment: card (Stripe) and cash/invoice supported
- [ ] Auto-cancellation of unpaid provisionals (24h before)
- [ ] Reminders: 24h and 1h before appointment
- [ ] Email notifications on all state changes
- [ ] Cancellation with automatic refund
- [ ] Rescheduling flow (cancel + rebook in one transaction)
- [ ] Timezone-aware (provider timezone for display, UTC for storage)
- [ ] All routes use `router()` builder with `.auth()` / `.permission()`
- [ ] All routes appear in OpenAPI spec under appointment tags
- [ ] Analytics model: bookings count, revenue, no-show rate, cancellation rate
- [ ] 50+ tests covering slot generation edge cases, booking flow, concurrency
- [ ] Plugin installs via `plugins: [appointmentPlugin()]` in commerce config
