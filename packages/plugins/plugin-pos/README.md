# @porulle/plugin-pos

In-store POS: terminals, shifts with cash events, transactions (sale/return/exchange), payments, barcode lookup, returns, and receipts wired into checkout.

## Install

```bash
bun add @porulle/plugin-pos
```

Add to `commerce.config.ts`:

```typescript
import { posPlugin } from "@porulle/plugin-pos";

export default defineConfig({
  plugins: [posPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-pos/src/schema.ts",
  // ...
],
```

## What it does

Registers POS tables for terminals, shifts, transactions, payments, and return line items; exposes REST for floor operations and attaches checkout hooks so POS checkouts zero shipping and finalize the linked POS transaction.

## Routes exposed

- **`/pos/terminals`** — `POST/GET /`, `PATCH/DELETE /{id}`
- **`/pos/shifts`** — `POST /open`, `POST /{id}/close`, `GET /current`, `GET /{id}`, `GET /{id}/report`, `POST/GET /{id}/cash-events`
- **`/pos/transactions`** — `POST /`, `GET /held`, `GET /{id}`, line items, customer, hold/recall/void, **`/pos/transactions/{id}/payments`**, **`/complete`**, **`/pos/transactions/{id}/receipt`**, **`POST .../receipt/email`**
- **`/pos/lookup`** — `GET /barcode/{code}`, `/sku/{sku}`, `/search`
- **`/pos/returns`** — `POST /`, `POST /{id}/payments`, `POST /{id}/complete`

## Hooks

**Emitted:** none.

**Consumed:** **`checkout.beforePayment`** — sets `shippingTotal = 0` when `metadata.posTransactionId` is set. **`checkout.afterCreate`** — completes POS transaction and updates shift counters when order metadata includes POS IDs.

## MCP tools

- **`pos_shift`** — `open`, `close`, `report`
- **`pos_transaction`** — `create`, `get`, `void`, `list_held`

## Configuration options

`POSPluginOptions`: `defaultCurrency`, `maxHoldHours`, `discountOverrideThreshold`.

## License

MIT
