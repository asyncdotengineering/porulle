# @porulle/plugin-uom

Units of measure, conversions between units, and per-entity UOM assignments for catalog and operations.

## Install

```bash
bun add @porulle/plugin-uom
```

Add to `commerce.config.ts`:

```typescript
import { uomPlugin } from "@porulle/plugin-uom";

export default defineConfig({
  plugins: [uomPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-uom/src/schema.ts",
  // ...
],
```

## What it does

Maintains a canonical unit list, directed conversion factors, optional per-entity stocking/selling units, and a convert helper for quantity translation across the graph.

## Routes exposed

**`/uom`** — `POST/GET /units`, `POST/GET /conversions`, `POST /convert`, `POST/GET /entities/{id}/uom`

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

None.

## Configuration options

None (`uomPlugin()` takes no options).

## License

MIT
