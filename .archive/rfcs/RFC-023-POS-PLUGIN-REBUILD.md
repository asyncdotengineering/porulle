# RFC-023: POS Plugin Rebuild — Tier 0 Core Primitives

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-19
- **Scope:** `packages/plugins/plugin-pos/` (full rewrite), `packages/core/src/modules/cart/schemas.ts` (minor), `packages/core/src/hooks/checkout.ts` (POS payment adapter)
- **Motivation:** The current POS plugin is a skeleton that bypasses the checkout pipeline entirely. It hardcodes prices at $10.00, skips inventory deduction, skips tax calculation, skips promotions, and lacks every primitive a real point-of-sale system requires. No business -- from a flower shop to a restaurant chain -- can use it. This RFC scraps the existing implementation and rebuilds from first principles, targeting the universal POS primitives that every physical commerce operation requires regardless of industry vertical.
- **Supersedes:** The existing `plugin-pos` implementation. The current schema (`pos_sessions` table), routes (6 endpoints), and hooks (1 unused) are deleted and replaced.
- **Prior art:** Square POS (universal primitives + vertical add-ons), Shopify POS (checkout pipeline shared with online), Toast POS (restaurant-specific extensions on core POS), Odoo POS (offline-first with server sync), ERPNext POS (web-based with shift management)
- **Estimated effort:** 10-14 engineering-days
- **Follow-up:** RFC-024 (Tier 1 vertical extensions: restaurant modifiers/tables/KDS, grocery weight/PLU, retail serial numbers/BOPIS)

---

## Industry Research Summary

This RFC is informed by analysis of 10 POS systems (commercial and open-source), 30+ feature comparison sources, and the complete database schemas of Odoo POS, UniCenta oPOS, ERPNext POS, and Square's payment API.

**Architecture patterns observed:**

| Pattern | Systems | Trade-off |
|---------|---------|-----------|
| Offline-first PWA (IndexedDB + server sync) | Odoo, Simpos | Best UX, complex sync |
| Client-server (API calls for every op) | ERPNext, Go POS | Simpler, requires connectivity |
| Headless API (POS is another sales channel) | Medusa, UC | Cleanest for unified commerce |
| Thick desktop client (direct DB) | UniCenta, Floreant | Maximum hardware control, no web |

**UC follows the headless API pattern** (like Medusa): POS is another channel consuming the same checkout/order/inventory APIs. No separate POS database for products or orders — the POS plugin adds session/shift/terminal management and delegates commerce operations to core.

**Key schema patterns from industry:**

| Concept | Odoo | UniCenta | Square | UC RFC-023 |
|---------|------|----------|--------|-----------|
| Terminal/Register | `pos.config` | Implicit (HOST field) | Location + Device | `pos_terminals` |
| Shift/Session | `pos.session` (state machine) | `CLOSEDCASH` | N/A (API-first) | `pos_shifts` |
| Transaction | `pos.order` | `TICKETS` | `Order` | `pos_transactions` |
| Line items | `pos.order.line` | `TICKETLINES` | `line_items[]` | Uses core `cart_line_items` |
| Payments | `pos.payment` (multiple per order) | `PAYMENTS` | `tenders[]` | `pos_payments` |
| Cash events | Manual adjustment entries | `DRAWEROPENED` audit | N/A | `pos_cash_events` |
| Returns | `is_refund` + `refunded_order_id` | `TICKETSNUM_REFUND` | `returns[]` on Order | `pos_return_items` |
| Modifiers | `product.combo` system | Normalized attribute tables | `modifiers[]` on line | Tier 1 (RFC-024) |
| Tax | Per-line + fiscal positions | Separate `TAXLINES` table | Scoped tax objects | Core checkout pipeline |

**Key insight from Odoo:** The shift state machine (`opening_control -> opened -> closing_control -> closed`) with `cash_register_balance_start`, `cash_register_balance_end_real` (actual count), and `cash_register_balance_end` (theoretical) is the industry-standard pattern for cash management. This RFC follows the same model.

**Key insight from Square:** Tenders are separate from payments. A tender is what the customer gives (cash, card). A payment is the processing result. Cash tenders track `buyer_tendered_money` and `change_back_money` separately. This RFC follows this model via `pos_payments.amount` (what was charged) and `pos_payments.changeGiven` (for cash overpayment).

**Key insight from UniCenta:** Void tracking requires a separate audit table (`LINEREMOVED`). Simply deleting a cart line item loses the audit trail. This RFC tracks voids via the `voidReason` field on transactions and the core audit log.

**Thermal printing:** The `@point-of-sale/receipt-printer-encoder` npm ecosystem by NielsLeenheer provides TypeScript-native ESC/POS, StarLine, and StarPRNT support via WebUSB, WebBluetooth, WebSerial, and TCP/IP. This is the recommended integration path for Tier 1 (deferred from Tier 0 to keep the core API-focused).

**Sources:** Odoo POS (`github.com/odoo/odoo`), UniCenta oPOS (`github.com/herbiehp/unicenta`), ERPNext POS (`github.com/frappe/erpnext`), Simpos (`github.com/hieuhani/simpos`), Square Orders API, Toast POS, Shopify POS, Clover POS, Lightspeed POS, SelectHub POS Features Checklist 2026, US Chamber of Commerce POS Buyer Guide.

---

## 0. Why a Full Rewrite

The current POS plugin has six fundamental flaws that cannot be fixed incrementally:

1. **Bypasses the checkout pipeline.** The tender route calls `orders.create()` directly instead of `checkout.create()`. This means POS orders get no price resolution, no tax, no inventory reservation, no promotions, no payment authorization, and no fulfillment. Fixing this requires restructuring the entire tender flow.

2. **No price resolution.** Every scanned item defaults to $10.00 because the cart service's `unitPriceSnapshot` fallback is 1000 and the POS plugin never resolves prices from the pricing engine.

3. **No shift management.** There is no concept of a shift (open/close), no cash drawer tracking, no Z-report, no X-report. Clock-in/out is a token create/revoke with zero persistence.

4. **No split payment flow.** The tender route finalizes the order on the first call. There is no mechanism for "add $20 cash, then add $30 card, then close."

5. **No item-level operations.** There is no route to remove an item, change quantity, apply a line-item discount, or void a single line item from the active transaction.

6. **Barcode lookup is O(N).** The scan route fetches up to 250 entities and iterates all their variants in memory. This is unusable for any catalog larger than 100 products.

An incremental fix would touch every route, the schema, the hooks, and the cart integration. It is faster and safer to rebuild.

---

## 1. Design Principles

### 1.1 POS Goes Through the Checkout Pipeline

The single most important architectural decision: POS tender calls `POST /api/checkout` (the same endpoint the storefront uses), not `orders.create()` directly. This gives POS:

- Price resolution from the pricing engine (time-windowed pricing, quantity brackets, customer group pricing)
- Tax calculation from the tax service
- Inventory availability check and reservation via `SELECT FOR UPDATE`
- Promotion and coupon application
- Payment authorization and capture via payment adapters
- Fulfillment initiation
- Order confirmation and audit logging

POS-specific behavior (cash payment, no shipping, receipt generation) is handled by a POS payment adapter and `checkout.beforeCreate` hooks, not by bypassing the pipeline.

### 1.2 Transactions, Not Sessions

The current plugin models POS activity as a "session" -- an amorphous container with a cart and tenders. Real POS systems model two distinct concepts:

- **Shift:** An operator's working period at a terminal. Has opening cash float, sales totals, cash events (drops, pickups), and closing count. One shift per operator per terminal per day.
- **Transaction:** A single sale, return, or exchange. Has line items, payments, and a receipt. Many transactions per shift.

This RFC separates these cleanly. A shift is opened when an operator clocks in and closed at end-of-day. Transactions are created within a shift.

### 1.3 Offline-Capable Architecture

Every POS route must be designed so that a future offline mode can queue operations locally and sync on reconnect. This means:

- All transaction IDs are UUIDs generated client-side (not server-side auto-increment)
- All operations are idempotent (replaying a queued operation produces the same result)
- All state transitions are explicit (no implicit side effects that require server state)

This RFC does not implement offline mode. It designs the API so that offline mode can be added without breaking changes.

### 1.4 Universal Primitives Only

This RFC covers only the operations that EVERY POS needs, regardless of whether it is a flower shop, a burger joint, a grocery store, or a clothing boutique:

- Ring up items (scan, search, manual entry)
- Price resolution and tax
- Discounts (line-item and transaction-level)
- Payments (cash, card, split, gift card)
- Receipts
- Voids and returns
- Shifts and cash drawer management
- Hold/recall transactions
- Barcode lookup via indexed query

Restaurant-specific features (modifiers, tables, KDS, courses, tips), grocery-specific features (weight-based items, PLU codes, age verification, EBT), and retail-specific features (serial numbers, BOPIS, layaway) are deferred to RFC-024 as Tier 1 vertical extensions that layer on top of these primitives.

---

## 2. Data Model

### 2.1 Tables

Six tables replace the current single `pos_sessions` table.

**Table: `pos_terminals`**

Represents a physical register or device. Terminals are registered by an admin and persist across shifts.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `organizationId` | text | NOT NULL | FK to organization |
| `name` | text | NOT NULL | Human-readable label ("Register 1", "Mobile iPad") |
| `code` | text | NOT NULL | Short identifier for receipts ("R1", "M2") |
| `type` | text | NOT NULL | "register", "tablet", "mobile", "kiosk" |
| `isActive` | boolean | NOT NULL, default true | Disabled terminals cannot open shifts |
| `metadata` | jsonb | default {} | Hardware config, printer assignment, etc. |
| `createdAt` | timestamp(tz) | NOT NULL | |
| `updatedAt` | timestamp(tz) | NOT NULL | |

Composite unique: `(organizationId, code)`.

**Table: `pos_shifts`**

Represents an operator's working period at a terminal. Exactly one open shift per terminal at a time.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `organizationId` | text | NOT NULL | |
| `terminalId` | uuid | NOT NULL, FK | |
| `operatorId` | text | NOT NULL | Better Auth user ID |
| `status` | text | NOT NULL | "open", "closed" |
| `openingFloat` | integer | NOT NULL, default 0 | Starting cash in drawer (cents) |
| `closingCount` | integer | | Actual cash counted at close (cents) |
| `expectedCash` | integer | | Calculated: opening + cash sales - cash refunds - drops + pickups |
| `cashVariance` | integer | | closingCount - expectedCash (over/short) |
| `salesCount` | integer | NOT NULL, default 0 | Total completed transactions |
| `salesTotal` | integer | NOT NULL, default 0 | Total sales amount (cents) |
| `refundsCount` | integer | NOT NULL, default 0 | |
| `refundsTotal` | integer | NOT NULL, default 0 | |
| `voidsCount` | integer | NOT NULL, default 0 | |
| `openedAt` | timestamp(tz) | NOT NULL | |
| `closedAt` | timestamp(tz) | | |
| `metadata` | jsonb | default {} | |

Constraint: only one `status = 'open'` shift per `(terminalId)` at any time (enforced in service layer, not DB constraint).

**Table: `pos_cash_events`**

Tracks cash drawer operations within a shift.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `shiftId` | uuid | NOT NULL, FK | |
| `type` | text | NOT NULL | "float", "drop", "pickup", "paid_in", "paid_out" |
| `amount` | integer | NOT NULL | Always positive. Direction determined by type. |
| `reason` | text | | "Bank deposit", "Petty cash", etc. |
| `performedBy` | text | NOT NULL | Operator ID |
| `performedAt` | timestamp(tz) | NOT NULL | |

**Table: `pos_transactions`**

Represents a single sale, return, or exchange. Contains the cart reference and payment records.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `organizationId` | text | NOT NULL | |
| `shiftId` | uuid | NOT NULL, FK | |
| `terminalId` | uuid | NOT NULL, FK | |
| `operatorId` | text | NOT NULL | |
| `cartId` | uuid | NOT NULL, FK to carts | The underlying cart |
| `orderId` | uuid | FK to orders | Set after successful checkout |
| `type` | text | NOT NULL | "sale", "return", "exchange" |
| `status` | text | NOT NULL | "open", "held", "completed", "voided" |
| `customerId` | uuid | | Optional customer linkage |
| `receiptNumber` | text | NOT NULL | Sequential per terminal per day: "R1-0001" |
| `subtotal` | integer | NOT NULL, default 0 | Sum of line items after discounts |
| `taxTotal` | integer | NOT NULL, default 0 | |
| `total` | integer | NOT NULL, default 0 | subtotal + taxTotal |
| `discountTotal` | integer | NOT NULL, default 0 | |
| `holdLabel` | text | | Name/description when held ("John's order") |
| `voidReason` | text | | Required when voiding |
| `metadata` | jsonb | default {} | |
| `createdAt` | timestamp(tz) | NOT NULL | |
| `completedAt` | timestamp(tz) | | |

**Table: `pos_payments`**

Individual payment records within a transaction. Supports split payment (multiple rows per transaction).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `transactionId` | uuid | NOT NULL, FK | |
| `method` | text | NOT NULL | "cash", "card", "gift_card", "store_credit", "other" |
| `amount` | integer | NOT NULL | Amount tendered (cents) |
| `changeGiven` | integer | NOT NULL, default 0 | For cash overpayment |
| `reference` | text | | Card last 4, gift card code, auth code |
| `status` | text | NOT NULL | "collected", "refunded" |
| `processedAt` | timestamp(tz) | NOT NULL | |
| `metadata` | jsonb | default {} | Card type, entry mode, terminal response |

**Table: `pos_return_items`**

Links return transactions to original order line items.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK | |
| `transactionId` | uuid | NOT NULL, FK to pos_transactions | The return transaction |
| `originalOrderId` | uuid | NOT NULL, FK to orders | |
| `originalLineItemId` | uuid | NOT NULL, FK to order_line_items | |
| `quantity` | integer | NOT NULL | Quantity being returned |
| `reason` | text | NOT NULL | "defective", "wrong_item", "changed_mind", "other" |
| `restockingFee` | integer | NOT NULL, default 0 | |
| `refundAmount` | integer | NOT NULL | Net refund after restocking fee |
| `createdAt` | timestamp(tz) | NOT NULL | |

### 2.2 Core Schema Change: Cart Line Item Notes

The `cart_line_items` table gains an optional `notes` column for POS-specific instructions ("no ice", "gift wrap", "hold for customer"). This is NOT modifiers (Tier 1) -- it is free-text notes.

```
ALTER TABLE cart_line_items ADD COLUMN notes TEXT;
```

### 2.3 Receipt Number Generation

Receipt numbers are sequential per terminal per day: `{terminal_code}-{sequence}`. Example: "R1-0001", "R1-0002". The sequence resets daily. Generated by counting existing transactions for the terminal on the current date.

---

## 3. API Design

### 3.1 Terminal Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/pos/terminals` | `pos:admin` | Register a new terminal |
| `GET` | `/api/pos/terminals` | `pos:admin` | List all terminals |
| `PATCH` | `/api/pos/terminals/{id}` | `pos:admin` | Update terminal (name, active status) |
| `DELETE` | `/api/pos/terminals/{id}` | `pos:admin` | Deactivate terminal |

### 3.2 Shift Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/pos/shifts/open` | `pos:operate` | Open a shift (clock in). Requires `terminalId`, `openingFloat`. Fails if terminal already has an open shift. |
| `POST` | `/api/pos/shifts/{id}/close` | `pos:operate` | Close a shift (clock out). Requires `closingCount` (actual cash counted). Calculates variance. |
| `GET` | `/api/pos/shifts/current` | `pos:operate` | Get the current open shift for the authenticated operator. |
| `GET` | `/api/pos/shifts/{id}` | `pos:operate` | Get shift details with summary totals. |
| `GET` | `/api/pos/shifts/{id}/report` | `pos:admin` | Z-report: complete shift summary with sales breakdown, payment method totals, cash events, variance. |

### 3.3 Cash Drawer Events

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/pos/shifts/{id}/cash-events` | `pos:operate` | Record a cash event (drop, pickup, paid_in, paid_out). |
| `GET` | `/api/pos/shifts/{id}/cash-events` | `pos:operate` | List cash events for a shift. |

### 3.4 Transaction Lifecycle

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/pos/transactions` | `pos:operate` | Start a new transaction. Creates a cart internally. Returns transaction with `cartId`. |
| `GET` | `/api/pos/transactions/{id}` | `pos:operate` | Get transaction with line items and payments. |
| `POST` | `/api/pos/transactions/{id}/items` | `pos:operate` | Add item by `entityId`+`variantId`, or by barcode scan. Delegates to `cart.addItem()`. |
| `PATCH` | `/api/pos/transactions/{id}/items/{itemId}` | `pos:operate` | Update quantity or notes on a line item. |
| `DELETE` | `/api/pos/transactions/{id}/items/{itemId}` | `pos:operate` | Remove a line item from the transaction. |
| `POST` | `/api/pos/transactions/{id}/items/{itemId}/discount` | `pos:manage` | Apply a line-item discount (percentage or fixed amount). Manager override may be required. |
| `POST` | `/api/pos/transactions/{id}/discount` | `pos:manage` | Apply a transaction-level discount. |
| `POST` | `/api/pos/transactions/{id}/customer` | `pos:operate` | Associate a customer with the transaction. |
| `POST` | `/api/pos/transactions/{id}/hold` | `pos:operate` | Park the transaction with a label. Status becomes "held". |
| `GET` | `/api/pos/transactions/held` | `pos:operate` | List held transactions for the current terminal. |
| `POST` | `/api/pos/transactions/{id}/recall` | `pos:operate` | Resume a held transaction. Status returns to "open". |
| `POST` | `/api/pos/transactions/{id}/void` | `pos:manage` | Void the entire transaction. Requires reason. |

### 3.5 Payment (Tender)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/pos/transactions/{id}/payments` | `pos:operate` | Add a payment. Does NOT finalize. Supports partial payments. |
| `POST` | `/api/pos/transactions/{id}/complete` | `pos:operate` | Finalize the transaction. Validates total payments >= total. Calls `POST /api/checkout` internally. Returns order + receipt. |

The separation of "add payment" and "complete" enables split payment:

```
POST /payments  { method: "cash", amount: 2000 }     # $20 cash
POST /payments  { method: "card", amount: 3000 }     # $30 card
POST /complete                                        # finalize
```

### 3.6 Returns

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/pos/returns` | `pos:manage` | Create a return transaction. Requires `originalOrderId` and items to return. Creates a negative-amount order via checkout pipeline. Restores inventory. |
| `POST` | `/api/pos/returns/{id}/payments` | `pos:operate` | Add refund payment (cash, card, store credit). |
| `POST` | `/api/pos/returns/{id}/complete` | `pos:operate` | Finalize the return. |

### 3.7 Item Lookup

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/pos/lookup/barcode/{code}` | `pos:operate` | Find entity+variant by barcode. Single indexed DB query on `variants.barcode`. Returns entity with resolved price. |
| `GET` | `/api/pos/lookup/sku/{sku}` | `pos:operate` | Find entity+variant by SKU. |
| `GET` | `/api/pos/lookup/search?q=...` | `pos:operate` | Quick text search across entity attributes. |

### 3.8 Receipt

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/pos/transactions/{id}/receipt` | `pos:operate` | Full receipt data: store info, line items with names/prices, discounts, tax breakdown, payments, change, receipt number, timestamp, operator name. |
| `POST` | `/api/pos/transactions/{id}/receipt/email` | `pos:operate` | Email the receipt to a customer. |

---

## 4. Checkout Pipeline Integration

### 4.1 POS Payment Adapter

A new payment adapter `pos-payment` is registered that handles POS-specific payment methods:

```
Pseudocode: POSPaymentAdapter

ADAPTER pos-payment:
  providerId = "pos"

  createPaymentIntent(params):
    // POS payments are collected at the terminal, not authorized online.
    // The "intent" is the sum of pos_payments rows.
    RETURN Ok({ id: "pos_" + params.orderId, status: "requires_capture", amount: params.amount })

  capturePayment(intentId, amount):
    // POS payments are already collected. Capture is a no-op.
    RETURN Ok({ id: intentId, status: "succeeded", amountCaptured: amount })

  refundPayment(paymentId, amount):
    // POS refunds are handled by the return transaction flow.
    RETURN Ok({ id: "ref_" + paymentId, status: "succeeded", amountRefunded: amount })
```

### 4.2 POS-Specific Checkout Hooks

Two hooks customize the checkout pipeline for POS transactions:

**`checkout.beforePayment` (POS shipping override):**

POS transactions have no shipping. This hook sets `shippingTotal = 0` when the checkout metadata indicates a POS transaction.

```
Pseudocode:

IF data.metadata?.posTransactionId:
  data.shippingTotal = 0
  data.shippingAddress = null
RETURN data
```

**`checkout.afterCreate` (POS transaction finalization):**

After the order is created, update the POS transaction with the `orderId`, set status to "completed", increment the shift's sales counters.

```
Pseudocode:

IF result AND data.metadata?.posTransactionId:
  UPDATE pos_transactions SET orderId = result.id, status = "completed", completedAt = NOW()
  UPDATE pos_shifts SET salesCount = salesCount + 1, salesTotal = salesTotal + result.grandTotal
```

---

## 5. Barcode Lookup Fix

The current implementation fetches up to 250 entities and iterates all variants in memory. The fix is a single indexed query:

```sql
SELECT v.id AS variant_id, v.entity_id, v.barcode, v.sku,
       e.type, e.slug, e.organization_id
FROM variants v
JOIN sellable_entities e ON v.entity_id = e.id
WHERE v.barcode = $1 AND e.organization_id = $2
LIMIT 1;
```

The `variants.barcode` column already exists but has no index. Add:

```sql
CREATE INDEX idx_variants_barcode ON variants(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_variants_sku ON variants(sku) WHERE sku IS NOT NULL;
```

---

## 6. Permission Scopes

| Scope | Who Has It | What It Allows |
|-------|-----------|----------------|
| `pos:admin` | Owner, Manager | Register terminals, view all shifts, Z-reports, configure POS settings |
| `pos:manage` | Manager | Void transactions, apply discounts, process returns, override price |
| `pos:operate` | Cashier, Manager, Owner | Open/close shifts, ring up sales, accept payment, hold/recall, reprint receipts |

---

## 7. User Persona Validation

### 7.1 Ideal User (cooperative, best-case)

A cashier at a clothing boutique. Opens shift with $200 float. Scans items with barcode scanner. Customer pays $50 cash + $30 card. Receipt prints automatically. End of day: closes shift, counts cash, Z-report shows $5 over (a tip left by a customer). Everything works.

**How it holds up:** Every step maps to a route. Shift open/close with float/count. Split payment. Receipt with line items. Z-report with variance.

### 7.2 Hard-Sell User (skeptical, demanding proof)

A restaurant owner evaluating UC POS vs Toast. Asks: "Can my servers enter modifiers? Can they split a check 4 ways? Can I see which server sold the most?"

**What they challenge:** Modifiers, table management, KDS, tips, per-server reporting. These are Tier 1 (RFC-024) features. For Tier 0, we are transparent: "This is the foundation. Restaurant extensions are a separate plugin that adds modifiers, tables, and kitchen routing."

**What we CAN show:** The checkout pipeline handles pricing, tax, inventory, and promotions. The shift model tracks per-operator sales. The plugin architecture means restaurant features compose on top without forking.

### 7.3 Bad User (careless, edge-case prone)

A cashier who:
- Scans the same item 50 times then tries to void 49 of them
- Enters $0.01 as a cash payment and tries to complete
- Holds 20 transactions and never recalls them
- Closes the shift without counting cash
- Tries to process a return on an order from a different store

**Where it breaks:** Each of these must be handled:
- Item void: `DELETE /transactions/{id}/items/{itemId}` works for any quantity
- Partial payment: `complete` validates `sum(payments) >= total`; rejects if insufficient
- Stale holds: TTL on held transactions (24h, configurable), auto-void on shift close
- Missing count: `closingCount` is required on shift close; API rejects without it
- Cross-org return: `originalOrderId` lookup is org-scoped; returns 404 for other orgs

### 7.4 Disappointed User (expectations unmet)

A grocery store owner who needs:
- Scale integration for produce (price-per-weight)
- EBT/SNAP payment acceptance
- Age verification prompts for alcohol

**What leaves them dissatisfied:** These are Tier 1 features. Tier 0 does not support decimal quantities (for weight), specialized payment types (EBT), or item-level compliance flags (age verification). The disappointed user needs to wait for RFC-024 or build a plugin.

**Mitigation:** The architecture is designed so these features can be added without breaking changes. `cart_line_items.metadata` can carry weight data. The payment adapter pattern supports any payment method. The hook system can inject age-verification checks.

---

## 8. File Structure

```
packages/plugins/plugin-pos/
  src/
    index.ts                          -- defineCommercePlugin entry
    schema.ts                         -- 6 Drizzle tables (terminals, shifts, cash_events,
                                         transactions, payments, return_items)
    types.ts                          -- shared TypeScript types
    services/
      terminal-service.ts             -- terminal CRUD
      shift-service.ts                -- open/close, cash events, Z-report
      transaction-service.ts          -- transaction lifecycle, hold/recall, void
      payment-service.ts              -- tender collection, split payment, complete
      return-service.ts               -- return transaction flow
      lookup-service.ts               -- barcode, SKU, search (indexed queries)
      receipt-service.ts              -- receipt data assembly
    routes/
      terminals.ts                    -- terminal CRUD routes
      shifts.ts                       -- shift management + cash events
      transactions.ts                 -- transaction lifecycle routes
      payments.ts                     -- payment collection + complete
      returns.ts                      -- return flow routes
      lookup.ts                       -- barcode/SKU/search routes
      receipts.ts                     -- receipt routes
    hooks/
      checkout-pos.ts                 -- beforePayment (zero shipping) + afterCreate (finalize)
    payment-adapter.ts                -- POS payment adapter for checkout pipeline
  test/
    shift-management.test.ts          -- open/close, cash events, Z-report
    transaction-lifecycle.test.ts     -- ring up, hold/recall, void, complete
    split-payment.test.ts             -- partial tenders, multi-method payment
    returns.test.ts                   -- return flow, inventory restoration
    barcode-lookup.test.ts            -- indexed query, org-scoped
    adversarial.test.ts               -- edge cases from persona validation
```

---

## 9. Verification Checklist

1. `npx tsc --noEmit` -- zero errors in plugin + core
2. Shift: open with float, cash drop, close with count, Z-report shows variance
3. Transaction: scan barcode, add 3 items, remove 1, apply 10% discount, complete with cash
4. Split payment: $20 cash + $15 card on a $35 total
5. Hold/recall: hold transaction "John", start new transaction, recall "John", complete
6. Void: void an open transaction, verify inventory not deducted
7. Return: return 1 item from a prior order, verify inventory restored, refund issued
8. Checkout pipeline: POS transaction goes through pricing, tax, inventory, promotions
9. Barcode lookup: single indexed query, org-scoped, returns entity + variant + price
10. Multi-org: terminal in org A cannot access transactions from org B
11. Concurrent: two terminals ringing up last item in stock -- one succeeds, one fails

---

## 10. What This RFC Does NOT Cover (Deferred to RFC-024)

| Feature | Vertical | Why Deferred |
|---------|----------|-------------|
| Item modifiers (toppings, sides, extras) | Restaurant | Requires modifier groups schema, forced modifier validation, modifier pricing. Separate plugin. |
| Table management (floor plan, seating) | Restaurant | Requires tables schema, assignment to transactions, server sections. |
| Kitchen Display System (KDS) | Restaurant | Requires station routing, real-time push, prep status tracking. |
| Course management | Restaurant | Requires fire-by-course sequencing, hold courses. |
| Tips | Restaurant | Requires tip entry on payment, tip pooling, tip reporting. |
| Weight-based items (decimal qty) | Grocery | Requires scale integration, tare weight, per-unit pricing. Needs `quantity` to support decimals. |
| PLU codes | Grocery | Requires PLU lookup table, quick-entry keypad. |
| Age verification | Grocery | Requires item-level flag, operator prompt, ID scan. |
| EBT/SNAP payments | Grocery | Requires specialized payment adapter, item eligibility flags. |
| Serial number tracking | Retail | Requires serial capture at scan, serial-to-sale linkage. |
| BOPIS / ship-from-store | Retail | Requires online order integration, pick/pack workflow. |
| Layaway | Retail | Requires deposit tracking, payment plan, inventory reservation. |
| Offline mode | Universal | Requires local queue, sync engine, conflict resolution. Most impactful but most complex. |
| Customer-facing display | Universal | Requires display protocol, item-by-item feed. |
| Thermal printer integration | Universal | Requires ESC/POS command generation, printer discovery. |
| Self-checkout kiosk | Universal | Requires kiosk-mode UI, restricted operations. |
