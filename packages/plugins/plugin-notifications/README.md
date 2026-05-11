# @porulle/plugin-notifications

Templates, multi-channel send, customer preferences, notification log, and print jobs with pluggable SMS, push, and print adapters.

## Install

```bash
bun add @porulle/plugin-notifications
```

Add to `commerce.config.ts`:

```typescript
import { notificationsPlugin } from "@porulle/plugin-notifications";

export default defineConfig({
  plugins: [
    notificationsPlugin({
      /* optional NotificationAdapters: sms, push, print */
    }),
  ],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-notifications/src/schema.ts",
  // ...
],
```

## What it does

CRUD for notification templates (email/SMS/push/print), rendered sends with logging, per-customer preference endpoints, and print job submission/status for receipts and labels. Pass real adapters in production; console adapters exist for development.

## Routes exposed

- **`/notifications/templates`** — `POST/GET /`, `GET/PATCH/DELETE /{id}`
- **`/notifications`** — `POST /send`, `GET /log`
- **`/notifications/preferences`** — `POST /`, `GET /{customerId}`
- **`/notifications/print`** — `POST /`, `GET /`, `GET /{id}`, `PATCH /{id}/status`

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

None.

## Configuration options

Constructor argument `adapters?: NotificationAdapters` — optional `sms`, `push`, and `print` implementations (`consoleSMSAdapter`, `consolePushAdapter`, `consolePrintAdapter` exported for dev).

## License

MIT
