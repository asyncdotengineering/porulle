# @porulle/plugin-loyalty

Points, tiers, leaderboard, and redemption offers tied to customers per organization.

## Install

```bash
bun add @porulle/plugin-loyalty
```

Add to `commerce.config.ts`:

```typescript
import { loyaltyPlugin } from "@porulle/plugin-loyalty";

export default defineConfig({
  // ...
  plugins: [loyaltyPlugin()],
});
```

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-loyalty/src/schema.ts",
  // ...
],
```

## What it does

Awards points from completed orders (`grandTotal`), maintains tiers from lifetime points, exposes redemption offers, and provides REST + MCP surfaces for balance and admin actions.

## Routes exposed

**`/loyalty`** — `GET /points/{customerId}`, `GET /leaderboard`, `POST /redeem`, `POST /offers`, `GET /offers`, `POST /offers/{id}/redeem` (permissions vary; some routes require `loyalty:admin` or auth).

## Hooks

**Emitted:** none.

**Consumed:** **`orders.afterCreate`** — earns points from order total when `customerId` is present (`resolveOrgId` for tenant).

## MCP tools

**`loyalty`** — `balance`, `earn`, `redeem`, `leaderboard`, `list_offers`

## Configuration options

`LoyaltyPluginOptions`: `pointsPerDollar`, `tierThresholds` (`silver`, `gold`, `platinum` point thresholds).

## License

MIT
