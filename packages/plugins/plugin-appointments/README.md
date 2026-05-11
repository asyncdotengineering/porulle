# @porulle/plugin-appointments

Headless booking for service types, providers, availability, and customer appointments with slot-based scheduling.

## Install

```bash
bun add @porulle/plugin-appointments
```

Add to `commerce.config.ts`:

```typescript
import { appointmentPlugin } from "@porulle/plugin-appointments";

export default defineConfig({
  // ...
  plugins: [appointmentPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-appointments/src/schema.ts",
  // ...
],
```

## What it does

Models service types, staff/resources (providers), weekly templates, breaks, day overrides, and bookings with payments. `BookingService` can enqueue notification jobs when a `JobsAdapter` is available from the kernel.

## Routes exposed

- **`/appointments/services`** — `GET/POST /`, `GET/PATCH/DELETE /{id}` (service types)
- **`/appointments/providers`** — `GET/POST /`, `GET/PATCH/DELETE /{id}`, `POST/GET /{id}/services`
- **`/appointments/bookings`** — `GET/POST /`, `GET /{id}`, `POST /{id}/confirm|complete|no-show|cancel|reschedule`
- **`/appointments/availability`** — `PUT/GET /{providerId}/weekly`, `POST/GET/DELETE` breaks and overrides, `GET /{providerId}/slots`
- **`/appointments/my-bookings`** — `GET /`, `GET /{id}` (authenticated customer)

## Hooks

**Emitted:** none (booking notifications use `BookingService` + jobs adapter, not core hooks).

**Consumed:** none.

## MCP tools

- **`appointments_booking`** — `create`, `cancel`, `get`, `list_by_provider`
- **`appointments_catalog`** — `list_services`, `list_providers`, `check_availability`

## Configuration options

`AppointmentPluginOptions`: `defaultDurationMinutes`, `defaultBufferBeforeMinutes`, `defaultBufferAfterMinutes`, `minNoticeMinutes`, `maxAdvanceDays`, `defaultTimezone`, `autoConfirmCashBookings`.

## License

MIT
