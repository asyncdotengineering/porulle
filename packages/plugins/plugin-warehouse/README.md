# @porulle/plugin-warehouse

Inter-warehouse stock transfers with approval and dispatch/receive, wastage notes, and stock reconciliations.

## Install

```bash
bun add @porulle/plugin-warehouse
```

Add to `commerce.config.ts`:

```typescript
import { warehousePlugin } from "@porulle/plugin-warehouse";

export default defineConfig({
  plugins: [warehousePlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-warehouse/src/schema.ts",
  // ...
],
```

## What it does

Models bins (schema), transfer headers/lines with workflow states, wastage with approval, and cycle-count style reconciliations with submit/approve steps.

## Routes exposed

**`/warehouse`** — transfers: `POST/GET /transfers`, `GET /transfers/{id}`, `POST .../approve|dispatch|receive`; wastage: `POST/GET /wastage`, `POST /wastage/{id}/approve`; reconciliations: `POST/GET /reconciliations`, `GET /reconciliations/{id}`, `POST .../submit|approve`

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

**`warehouse`** — `list_transfers`, `get_transfer`, `approve_transfer`, `dispatch_transfer`, `list_wastage`, `approve_wastage`, `list_reconciliations`, `get_reconciliation`, `submit_reconciliation`, `approve_reconciliation`

## Configuration options

None (`warehousePlugin()` takes no options).

## License

MIT
