# @porulle/plugin-production

Bill of materials (BOM), cost rollup, explosion, and production orders with material consumption tracking.

## Install

```bash
bun add @porulle/plugin-production
```

Add to `commerce.config.ts`:

```typescript
import { productionPlugin } from "@porulle/plugin-production";

export default defineConfig({
  plugins: [productionPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-production/src/schema.ts",
  // ...
],
```

## What it does

Defines multi-level BOMs, rolls up costs, explodes demand into components, and runs production orders from plan through consumption to complete or cancel.

## Routes exposed

**`/production`** — `POST/GET /boms`, `GET /boms/{id}`, `POST /boms/{id}/items`, `POST /boms/{id}/cost-rollup`, `POST /boms/{id}/explode`, `POST/GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/start|consume|complete|cancel`

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

**`production`** — `list_bom`, `get_bom`, `cost_rollup`, `explode`, `list_orders`, `get_order`, `start_order`, `complete_order`, `cancel_order`

## Configuration options

None (`productionPlugin()` takes no options).

## License

MIT
