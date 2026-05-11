# RFC-024: POS Vertical Extensions — Tier 1 Proposal

- **Status:** Proposal (not yet designed)
- **Author:** Engineering
- **Date:** 2026-03-19
- **Depends on:** RFC-023 (POS Tier 0 Core Primitives)
- **Scope:** Three separate plugins extending the POS plugin for restaurant, grocery, and retail verticals

---

## 0. Context

RFC-023 builds the universal POS primitives: transactions, payments, shifts, cash drawer, returns, and receipts. These work for any business that sells physical goods at a counter.

This RFC proposes three vertical extension plugins that layer on top of the Tier 0 primitives. Each extension is a separate `defineCommercePlugin` that adds schema, routes, and hooks to the POS plugin. A business installs only the extensions relevant to their vertical.

This document is a proposal, not a design. Each extension will receive its own detailed RFC when implementation begins.

---

## 1. Extension: Restaurant POS (`plugin-pos-restaurant`)

### What It Adds to Tier 0

| Feature | What It Does | How It Extends POS |
|---------|-------------|-------------------|
| **Item Modifiers** | "Extra cheese +$1.50", "No onions", "Well done" | Adds `modifier_groups` and `modifier_options` tables. `pos_transactions` items carry selected modifiers. Cart `addItem` hook validates required modifiers and sums modifier prices into the line item total. |
| **Table Management** | Visual floor plan, seat assignment, table status | Adds `pos_tables` table with zone, capacity, status. `pos_transactions` gain `tableId` FK. Table status changes on transaction open/complete/void. |
| **Kitchen Display System** | Station-aware order routing, prep tracking | Adds `kds_stations` and `kds_tickets` tables. Hook on transaction item add sends tickets to the correct station based on item category. Real-time push via SSE to KDS display clients. |
| **Course Management** | Fire starters first, then mains | `kds_tickets` gain `courseNumber`. "Fire next course" action sends next batch to kitchen. |
| **Dine-in / Takeaway** | Order type affects routing, packaging | `pos_transactions` gain `orderType` ("dine_in", "takeaway", "delivery"). KDS routing rules differ by type. |
| **Tips** | Tip entry on payment, tip pooling | `pos_payments` gain `tipAmount`. Tip pool configuration per shift. Tip reporting in Z-report. |
| **Bill Splitting** | Split by item, even split, custom amounts | Creates multiple orders from one transaction. Each split gets its own payment set and receipt. |
| **Tab Management** | Open tabs, transfer between servers | Held transactions with "tab" type. Transfer changes `operatorId`. Pre-authorization on card tabs. |
| **Forced Modifiers** | "Choose a side" (required selection) | Modifier groups with `isRequired: true` and `minSelect`/`maxSelect`. Cart addItem hook rejects if required modifiers not provided. |
| **Server Sections** | Assign tables to servers | `pos_tables` gain `assignedOperatorId`. Operators see only their section's tables. |

### Schema Additions

```
pos_modifier_groups       -- name, entityId, minSelect, maxSelect, isRequired, sortOrder
pos_modifier_options      -- groupId, name, priceAdjustment, isDefault, sortOrder
pos_tables                -- number, zone, capacity, status, assignedOperatorId
pos_table_assignments     -- tableId, transactionId
kds_stations              -- name, categories[], printerConfig
kds_tickets               -- orderId, stationId, items[], courseNumber, status, firedAt
```

### Estimated Effort

7-10 engineering-days for the full restaurant extension.

### Priority Order

1. Modifiers (blocks food ordering entirely)
2. Tables + dine-in/takeaway (core restaurant workflow)
3. KDS (kitchen operations)
4. Tips + bill splitting (nice-to-have for MVP)

---

## 2. Extension: Grocery POS (`plugin-pos-grocery`)

### What It Adds to Tier 0

| Feature | What It Does | How It Extends POS |
|---------|-------------|-------------------|
| **Weight-Based Items** | Price by lb/kg for produce, deli, bulk | Changes `cart_line_items.quantity` from integer to decimal. Adds `unitType` ("each", "lb", "kg", "oz") to entities. Scale integration reads weight and sets quantity. |
| **PLU Codes** | 4-digit codes for produce | Adds `plu_code` column to entities. PLU lookup route for quick keypad entry. Standard PLU directory (bananas = 4011). |
| **Age Verification** | Prompt for alcohol, tobacco | Adds `requiresAgeVerification` boolean to entity custom fields. POS scan hook prompts operator. ID scanner integration. |
| **EBT/SNAP Payments** | Food stamp acceptance | New payment adapter for EBT. Item eligibility flags (SNAP-eligible). Dual-tender (EBT for food + cash for non-food). |
| **Mix-and-Match Pricing** | "3 for $5", "Buy 2 Get 1" | Extends promotions engine with quantity-based pricing rules scoped to POS transactions. |
| **Bottle Deposits** | CRV/deposit tracking | Adds deposit amount to entity metadata. Deposit total shown separately on receipt. Deposit redemption flow. |
| **Department-Based Tax** | Different tax rates for prepared food vs groceries vs alcohol | Already supported by pricing engine's tax categories, but needs POS-friendly configuration UI. |

### Schema Additions

```
-- Minimal: mostly uses existing entity custom fields + metadata
-- PLU lookup is a column on sellable_entities or variants
-- EBT is a payment adapter, not a schema
```

### Estimated Effort

5-7 engineering-days. Most features are configuration/adapter work, not new schema.

### Priority Order

1. Weight-based items (produce is the core grocery use case)
2. PLU codes (speed of checkout)
3. Age verification (compliance requirement)
4. EBT (market access for grocery stores serving lower-income communities)

---

## 3. Extension: Retail POS (`plugin-pos-retail`)

### What It Adds to Tier 0

| Feature | What It Does | How It Extends POS |
|---------|-------------|-------------------|
| **Serial Number Tracking** | Capture serial at scan for electronics, jewelry | Adds `serial_number` column to `order_line_items`. Scan hook prompts for serial after barcode scan. Serial-to-sale linkage for warranty lookup. |
| **BOPIS (Buy Online Pick Up In Store)** | Online orders fulfilled at store | Integration with order service. POS displays pending BOPIS orders. Operator confirms pickup, marks fulfilled. |
| **Ship-From-Store** | Fulfill online orders from store inventory | Similar to BOPIS but with shipping label generation. Packing slip from POS. |
| **Exchanges** | Return + new sale in one transaction | Single transaction with return items (negative amounts) and new items (positive amounts). Net payment calculated. |
| **Layaway** | Deposit + payment plan | Adds `pos_layaway` table. Deposit collected, items reserved in inventory. Scheduled payments. Release on full payment or cancellation. |
| **Special Orders** | Order items not in stock | Creates a purchase order or back-order. Customer notification when item arrives. |
| **Gift Registry** | Wedding, baby registries | Customer-linked wish lists. POS lookup by registry. Mark items purchased. |

### Schema Additions

```
pos_layaway               -- transactionId, depositAmount, remainingBalance, installments, status
pos_bopis_orders          -- onlineOrderId, status (ready_for_pickup, picked_up), readyAt, pickedUpAt
```

### Estimated Effort

5-7 engineering-days.

### Priority Order

1. Exchanges (most common retail POS operation after sale/return)
2. Serial number tracking (high-value retail requirement)
3. BOPIS (omnichannel is the expectation in 2026)
4. Layaway (niche but important for furniture, appliances)

---

## 4. Shared Infrastructure (Built in RFC-023, Used by All Extensions)

All three extensions depend on the Tier 0 primitives from RFC-023:

| Primitive | Used By |
|-----------|---------|
| Transaction lifecycle | All (every sale starts as a transaction) |
| Split payment | Restaurant (bill splitting), Retail (layaway installments) |
| Returns | Retail (exchanges), Grocery (perishable returns) |
| Shift management | All (Z-reports, cash variance) |
| Checkout pipeline | All (pricing, tax, inventory, promotions) |
| Barcode lookup | All (scanning is universal) |
| Hold/recall | Restaurant (tabs), Retail (customer stepped away) |
| Receipt | All (receipt is the legal proof of sale) |
| Org scoping | All (multi-store chains) |

---

## 5. Plugin Composition

A restaurant installs:
```typescript
import { posPlugin } from "@unifiedcommerce/plugin-pos";
import { posRestaurantPlugin } from "@unifiedcommerce/plugin-pos-restaurant";

defineConfig({
  plugins: [
    posPlugin(),
    posRestaurantPlugin({ enableKDS: true, enableTips: true }),
  ],
});
```

A grocery store installs:
```typescript
import { posPlugin } from "@unifiedcommerce/plugin-pos";
import { posGroceryPlugin } from "@unifiedcommerce/plugin-pos-grocery";

defineConfig({
  plugins: [
    posPlugin(),
    posGroceryPlugin({ enableEBT: true, enableAgeVerification: true }),
  ],
});
```

A clothing boutique installs only Tier 0:
```typescript
import { posPlugin } from "@unifiedcommerce/plugin-pos";

defineConfig({
  plugins: [posPlugin()],
});
```

---

## 6. Estimated Total Effort

| RFC | Scope | Effort |
|-----|-------|--------|
| RFC-023 | Tier 0 Core Primitives | 10-14 days |
| RFC-024a | Restaurant Extension | 7-10 days |
| RFC-024b | Grocery Extension | 5-7 days |
| RFC-024c | Retail Extension | 5-7 days |
| **Total** | | **27-38 days** |

The Tier 0 primitives (RFC-023) should be built first. The vertical extensions can be built in parallel by different developers once Tier 0 is stable.
