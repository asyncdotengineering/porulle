# @porulle/plugin-pos-restaurant

Restaurant layer on top of `@porulle/plugin-pos`: tables, floor zones, optional modifiers and KDS, checklists, alerts, recipes (food BOM), and analytics.

## Install

```bash
bun add @porulle/plugin-pos @porulle/plugin-pos-restaurant
```

Add to `commerce.config.ts`:

```typescript
import { posPlugin } from "@porulle/plugin-pos";
import { posRestaurantPlugin } from "@porulle/plugin-pos-restaurant";

export default defineConfig({
  plugins: [posPlugin(), posRestaurantPlugin()],
});
```

(`posRestaurantPlugin` declares `requires: ["pos"]`.)

Add to `drizzle.config.ts`:

```typescript
schema: [
  "./node_modules/@porulle/plugin-pos-restaurant/src/schema.ts",
  // include plugin-pos schema as well
],
```

## What it does

Adds restaurant schema (modifiers, tables, KDS, checklists, alerts, recipes/combos/menu availability, P&L, favorites). Modifier and KDS route groups mount only when the corresponding options are enabled.

## Routes exposed

- **`/pos/restaurant/tables`** — CRUD tables, zones, assign/clear/transfer, layout
- **`/pos/restaurant/modifier-groups`** (+ **`/pos/restaurant/modifier-options`**) — when `enableModifiers`
- **`/pos/restaurant/kds`** — stations, tickets, transitions — when `enableKDS`
- **`/pos/restaurant/checklists`**, **`/pos/restaurant/alerts`**, **`/pos/restaurant/recipes`**, **`/pos/restaurant/analytics`** — operational and reporting endpoints (see route files for full paths)

## Hooks

**Emitted:** none.

**Consumed:** **`cart.beforeAddItem`** — validates modifier selections when `enableModifiers`. **`checkout.afterCreate`** — for POS transactions with table assignments, moves tables to `cleaning` and clears assignments (see `buildTableClearOnCompleteHook`).

## MCP tools

- **`restaurant_tables`** — `list`, `set_status`, `transfer`
- **`restaurant_kds`** — `list_tickets`, `transition`, `list_zones`

## Configuration options

`POSRestaurantPluginOptions`: `enableKDS`, `enableTips`, `enableModifiers`, `kdsAlertMinutes`.

## License

MIT
