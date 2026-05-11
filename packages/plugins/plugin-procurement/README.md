# @porulle/plugin-procurement

Suppliers with catalog links, purchase orders through approval, and goods-received notes for inbound receiving.

## Install

```bash
bun add @porulle/plugin-procurement
```

Add to `commerce.config.ts`:

```typescript
import { procurementPlugin } from "@porulle/plugin-procurement";

export default defineConfig({
  plugins: [procurementPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-procurement/src/schema.ts",
  // ...
],
```

## What it does

Manages supplier master data, links sellable items to suppliers, creates and approves POs, records GRNs, and accepts GRNs into inventory context via services (see procurement routes for permissions).

## Routes exposed

**`/procurement`** — `POST/GET /suppliers`, `GET /suppliers/{id}`, `POST /suppliers/{id}/items`, `POST/GET /purchase-orders`, `GET /purchase-orders/{id}`, `POST .../submit|approve|cancel`, `POST/GET /grn`, `GET /grn/{id}`, `POST /grn/{id}/accept`

## Hooks

**Emitted:** none.

**Consumed:** none.

## MCP tools

**`procurement`** — `list_suppliers`, `get_supplier`, `list_po`, `get_po`, `approve_po`, `cancel_po`, `list_grn`, `get_grn`, `accept_grn`

## Configuration options

None (`procurementPlugin()` takes no options).

## License

MIT
