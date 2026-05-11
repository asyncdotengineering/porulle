# @porulle/plugin-reviews

Customer reviews on catalog entities with moderation, replies, and aggregate summaries.

## Install

```bash
bun add @porulle/plugin-reviews
```

Add to `commerce.config.ts`:

```typescript
import { reviewsPlugin } from "@porulle/plugin-reviews";

export default defineConfig({
  plugins: [reviewsPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-reviews/src/schema.ts",
  // ...
],
```

## What it does

Stores per-entity reviews with optional verified order linkage, publishes after approval, supports merchant replies, and exposes summaries for storefront display.

## Routes exposed

**`/reviews`** — `POST /`, `GET /entity/{entityId}`, `GET /entity/{entityId}/summary`, `PATCH /{id}/approve`, `PATCH /{id}/reject`, `POST /{id}/reply`, `GET /mine`

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

**`reviews`** — `list`, `summary`, `submit`, `approve`

## Configuration options

None (`reviewsPlugin()` takes no options).

## License

MIT
