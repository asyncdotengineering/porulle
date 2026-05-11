# @porulle/plugin-giftcards

Stored-value gift cards with balance checks, checkout redemption, issuance from qualifying purchases, and admin lifecycle APIs.

## Install

```bash
bun add @porulle/plugin-giftcards
```

Add to `commerce.config.ts`:

```typescript
import { giftCardPlugin, giftCardPluginWithHooks } from "@porulle/plugin-giftcards";

export default defineConfig({
  // ...
  plugins: [
    giftCardPluginWithHooks(), // use for checkout + order hooks; giftCardPlugin() is routes/MCP only
  ],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-giftcards/src/schema.ts",
  // ...
],
```

## What it does

Persists gift cards and append-only transactions; supports partial redemption, checkout-time debits, compensation on failed checkout, issuance after checkout when configured, and refund credits on order updates.

## Routes exposed

- **`/gift-cards`** — Admin: `POST/GET /`, `GET /{id}`, `POST /{id}/disable`, `POST /{id}/adjust`. Public: `POST /check-balance`.
- **`/me/gift-cards`** — Customer: `GET /` (authenticated).

## Hooks

Only **`giftCardPluginWithHooks`** registers hooks:

- **`checkout.beforePayment`** — deducts balances from `metadata.giftCardCodes`
- **`checkout.afterCreate`** — compensates debits if checkout failed; issues cards from qualifying line items
- **`order.afterUpdate`** — refund credit paths when configured

**Consumed:** none (reads checkout/order payloads).

## MCP tools

**`giftcards`** — `check_balance`, `issue`, `get`, `list`, `transactions`

## Configuration options

`GiftCardPluginOptions`: `codeFormat`, `defaultExpiryDays`, `maxBalancePerCard`, `emailTemplate`, `allowPartialRedemption`, `productType` (entity type for issuance).

## License

MIT
