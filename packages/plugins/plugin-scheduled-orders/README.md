# @porulle/plugin-scheduled-orders

Defer order execution: schedule future placement and process due schedules in batch.

## Install

```bash
bun add @porulle/plugin-scheduled-orders
```

Add to `commerce.config.ts`:

```typescript
import { scheduledOrdersPlugin } from "@porulle/plugin-scheduled-orders";

export default defineConfig({
  plugins: [scheduledOrdersPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-scheduled-orders/src/schema.ts",
  // ...
],
```

## What it does

Persists scheduled orders with `scheduledFor`, cart linkage, and status (`scheduled`, `processing`, `completed`, `cancelled`, `expired`); lists and cancels them and exposes an admin endpoint to process due rows.

## Routes exposed

**`/scheduled-orders`** — `POST /`, `GET /`, `GET /{id}`, `POST /{id}/cancel`, `POST /process-due`

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

None.

## Configuration options

None (`scheduledOrdersPlugin()` takes no options).

## License

MIT
