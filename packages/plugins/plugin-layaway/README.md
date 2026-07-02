# @porulle/plugin-layaway

Layaway / partial-payment plans for `@porulle/core`: reserve items with a
deposit, pay the balance in installments, and complete the sale automatically
when it is paid off.

## Install

```bash
bun add @porulle/plugin-layaway
```

Add to `commerce.config.ts`:

```typescript
import { layawayPlugin } from "@porulle/plugin-layaway";

export default defineConfig({
  plugins: [
    layawayPlugin({
      defaultDepositPercent: 25, // used when a plan gives no deposit (default 20)
      onForfeit: async (layaway) => {
        // Policy hook — deposit retention, customer notification, etc.
      },
    }),
  ],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-layaway/src/schema.ts",
  // ...
],
```

## What it does

Registers the `layaways` and `layaway_payments` tables. On create it reserves
stock for the plan's items (rolled back if the reservation fails). Installments
are recorded in any tender; when the cumulative paid amount reaches the total
the plan auto-completes — a core order is created and cross-linked via
`metadata.layawayId`, and the stock hold is released. Forfeiting releases the
hold and runs the `onForfeit` policy hook (the plugin does not itself retain or
refund the deposit — that is your policy).

## Routes exposed

- **`POST /layaways`** — create a plan (`layaway:operate`)
- **`GET /layaways`** — list plans, optional `?status` (`layaway:operate`)
- **`GET /layaways/{id}`** — plan with its payment ledger (`layaway:operate`)
- **`POST /layaways/{id}/payments`** — record an installment; auto-completes at
  full payment (`layaway:operate` + core `orders:create`)
- **`POST /layaways/{id}/forfeit`** — forfeit a plan, release stock (`layaway:manage`)

See the [Layaway guide](https://github.com/asyncdotengineering/porulle/blob/main/apps/docs/src/content/docs/building/layaway.mdx)
for worked examples.
