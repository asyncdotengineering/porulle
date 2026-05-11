# @porulle/plugin-wishlist

Per-customer saved items for later purchase, with admin listing across users.

## Install

```bash
bun add @porulle/plugin-wishlist
```

Add to `commerce.config.ts`:

```typescript
import { wishlistPlugin } from "@porulle/plugin-wishlist";

export default defineConfig({
  plugins: [wishlistPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-wishlist/src/schema.ts",
  // ...
],
```

## What it does

Stores wishlist rows keyed to customers and catalog entities; authenticated shoppers manage their list while admins can query aggregate views.

## Routes exposed

**`/wishlist`** — `GET /`, `POST /`, `DELETE /{id}` (authenticated customer); `GET /admin` (`wishlist:admin`)

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

None.

## Configuration options

None (`wishlistPlugin()` takes no options).

## License

MIT
