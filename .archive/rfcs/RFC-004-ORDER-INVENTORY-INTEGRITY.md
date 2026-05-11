# RFC-004: Order & Inventory Lifecycle Integrity — Close the Gaps in Fulfillment, Refund, and Cancellation Flows

- **Status:** Complete
- **Author:** Engineering (QA Audit)
- **Date:** 2026-03-14
- **Scope:** `packages/core` (orders, inventory, fulfillment, payments), `packages/plugins/plugin-marketplace`
- **Depends on:** RFC-002 (implemented), RFC-003 (implemented)
- **Severity:** CRITICAL — affects money and stock accuracy
- **Estimated effort:** 3–4 days

---

## 1. Summary

An external audit of the order lifecycle reveals **5 confirmed bugs** and **3 architectural gaps** across the core engine and marketplace plugin. The root cause is a common pattern: the checkout compensation chain is well-engineered (reserve → capture → fulfill → confirm), but the **reverse flows** (cancel, refund, fulfillment completion) were never fully implemented.

The result: inventory that is reserved but never released, payments that are captured but never refunded, and fulfillment that creates records but never closes the inventory loop. Over time, this causes phantom stock loss — items appear unavailable even though they're physically in the warehouse.

---

## 2. Audit Methodology

- Read every line of `orders/service.ts`, `inventory/service.ts`, `inventory/repository/index.ts`, `fulfillment/service.ts`, `checkout.ts`, `checkout-completion.ts`, `machine.ts`
- Traced every code path for: checkout, cancel, refund, fulfillment, partial fulfillment
- Verified against live PostgreSQL (`runvae` database, 90 orders, 18 inventory levels, 120 movements)
- Cross-referenced with Shopify, MedusaJS, and WooCommerce inventory models
- Tested negative paths that have zero test coverage

---

## 3. Current Architecture (What Works)

The **checkout happy path** is correctly implemented with a compensation chain:

```
authorize payment
    ↓
create order (status: pending)
    ↓
compensation chain:
  1. reserve inventory     → if fails: stop (no charge)
  2. capture payment       → if fails: release inventory
  3. initiate fulfillment  → best-effort (no rollback)
  4. send confirmation     → best-effort (no rollback)
```

**What's correct:**
- Inventory reservation uses `SELECT FOR UPDATE` (race-condition safe)
- Payment capture fails → inventory automatically released via compensation
- Fulfillment is best-effort — failure doesn't block the order
- `paymentIntentId` is stored in `order.metadata.paymentIntentId` (verified in DB)
- Cancel (→ "cancelled") releases inventory and voids tax

---

## 4. Bug Report

### BUG-1: Refund Does Not Release Inventory [CRITICAL]

**File:** `packages/core/src/modules/orders/service.ts`, line 353-389

**Evidence:** The `changeStatus` method has an `if (input.newStatus === "cancelled")` block that releases inventory. There is **no equivalent block for `"refunded"`**.

```typescript
// Line 354: Only handles "cancelled"
if (input.newStatus === "cancelled") {
  if (inventory?.release) {
    for (const lineItem of lineItems) {
      await inventory.release({...});
    }
  }
  if (tax?.voidTransaction) { ... }
}
// No "refunded" handling exists
```

**State machine confirms the path exists:**
```typescript
// machine.ts line 35
fulfilled: ["refunded"],  // ← valid transition, no inventory/payment handling
```

**Impact:** An order that reaches `fulfilled → refunded` permanently locks `quantityReserved`. Available stock decreases by the refunded quantity forever. Over 100 refunds, a product with 500 units could show 0 available while 400 units sit untouched in the warehouse.

**Verified in DB:** Zero release movements exist (`SELECT * FROM inventory_movements WHERE type = 'release'` returns 0 rows). Zero refunded orders exist (never tested end-to-end).

---

### BUG-2: Refund Does Not Trigger Payment Refund [CRITICAL]

**File:** `packages/core/src/modules/orders/service.ts`, line 353-389

**Evidence:** When an order transitions to "refunded", no code calls `payments.refund()`. The `paymentIntentId` is stored in `order.metadata.paymentIntentId` (confirmed via psql), but the refund handler never reads it.

The compensation chain in `checkout-completion.ts` has a refund path (line 161-168), but that only fires if the checkout **fails mid-transaction**. Once checkout completes, there is no refund mechanism.

**Impact:** Customer is charged, order is marked "refunded", but money stays captured. Customer must file a chargeback. Platform loses the chargeback fee ($15-25) plus the refund amount.

---

### BUG-3: Cancel Does Not Trigger Payment Refund [HIGH]

**File:** `packages/core/src/modules/orders/service.ts`, line 353-389

**Evidence:** The cancel block (line 354-389) releases inventory and voids tax, but **does not refund the payment**. Payment was already captured during checkout (compensation step 2). Cancelling after capture should refund the customer.

```typescript
if (input.newStatus === "cancelled") {
  // ✓ Releases inventory
  // ✓ Voids tax transaction
  // ✗ Does NOT refund payment — customer's money stays captured
}
```

**Impact:** Same as BUG-2. An order cancelled after payment capture leaves the customer charged.

**Note:** If the order is cancelled *before* the compensation chain runs (extremely unlikely since checkout is synchronous), no payment was captured and no refund is needed. But the code has no way to distinguish this case.

---

### BUG-4: Fulfillment Does Not Deduct Inventory [HIGH]

**File:** `packages/core/src/modules/fulfillment/service.ts`, line 226-297

**Evidence:** `fulfillOrder()` creates fulfillment records for each line item but never calls `inventory.adjust()`, `inventory.release()`, or any inventory method. The inventory remains in the "reserved" state permanently.

**How it should work (Shopify/MedusaJS model):**

| Event | quantityOnHand | quantityReserved | Available |
|-------|---------------|-----------------|-----------|
| Seed: 100 units | 100 | 0 | 100 |
| Customer orders 5 | 100 | 5 | 95 |
| Order fulfilled (shipped) | **95** | **0** | 95 |
| Customer returns 2 | **97** | 0 | 97 |

**How our system works:**

| Event | quantityOnHand | quantityReserved | Available |
|-------|---------------|-----------------|-----------|
| Seed: 100 units | 100 | 0 | 100 |
| Customer orders 5 | 100 | 5 | 95 |
| Order fulfilled | 100 | **5** (unchanged) | 95 |
| Order refunded | 100 | **5** (unchanged) | 95 ← **BUG: should be 100** |

**Verified in psql:** `inventory_movements` only has `adjustment` and `reservation` types. Zero `fulfillment` type movements. `quantityOnHand` never decreases from its seeded value.

---

### BUG-5: Marketplace Sub-Order Cancel Does Not Release Parent Inventory [HIGH]

**File:** `packages/plugins/plugin-marketplace/src/services/sub-order.ts`, line 101-115

**Evidence:** `SubOrderService.cancel()` only updates the sub-order status. It does not:
1. Call core inventory to release the cancelled vendor's items
2. Notify the parent order that items are no longer being fulfilled
3. Adjust the vendor's balance ledger (sale credit should be reversed)

```typescript
async cancel(id: string, reason?: string) {
  // Only updates status + timestamps
  // No inventory.release() call
  // No balance ledger reversal
}
```

**Impact:** In a multi-vendor order, if Vendor A cancels their sub-order, the items from Vendor A remain reserved on the parent order. Other customers cannot buy those items. Vendor A's balance still shows the sale credit.

---

## 5. Architectural Gaps

### GAP-1: No `paymentIntentId` Column on Orders Table

**Current state:** `paymentIntentId` is stored inside `metadata` JSONB field (verified: `metadata->>'paymentIntentId'` returns values). This works but is fragile:
- No index on JSONB path — refund lookups scan all orders
- No type enforcement — could be missing or malformed
- Cannot be used in a WHERE clause efficiently
- Not visible in `SELECT *` — requires JSONB extraction

**Fix:** Add `payment_intent_id TEXT` column to `orders` table.

### GAP-2: No Inventory Timeout for Stale Reservations

If an order stays in "pending" forever (customer abandons after checkout), the reserved inventory is never released. There's no background job to scan for stale reservations.

**Standard practice:** Auto-cancel orders stuck in "pending" for >24-48 hours.

### GAP-3: `fulfillmentStatus` on Line Items Is Never Updated

The `order_line_items` table has a `fulfillment_status` column (schema line 36: `default("unfulfilled")`), but no code ever updates it to "fulfilled", "partially_fulfilled", or "shipped". It's dead data.

---

## 6. State Machine Analysis

```
                    ┌──────────┐
                    │ pending  │
                    └────┬─────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        ┌───────────┐         ┌──────────┐
        │ confirmed │         │cancelled │ ◄── releases inventory ✓
        └─────┬─────┘         │          │     voids tax ✓
              │               │          │     refunds payment ✗ ← BUG-3
              ▼               └──────────┘
        ┌────────────┐
        │ processing │──────────────────┐
        └─────┬──────┘                  │
              │                         ▼
    ┌─────────┴───────────┐       ┌──────────┐
    ▼                     ▼       │cancelled │
┌──────────────┐    ┌──────────┐  └──────────┘
│ partially_   │    │fulfilled │
│ fulfilled    │    └────┬─────┘
└──────┬───────┘         │
       │                 ▼
       │           ┌──────────┐
       │           │ refunded │ ◄── releases inventory ✗ ← BUG-1
       │           │          │     refunds payment ✗ ← BUG-2
       │           └──────────┘
       │
       └──► fulfilled ──► refunded
```

**Every arrow to a terminal state should trigger cleanup. Only `cancelled` does (partially).**

---

## 7. How Other Platforms Handle This

### Shopify

```
Order placed    → committed++, available--
Fulfilled       → committed--, on_hand--     (stock leaves warehouse)
Cancelled       → committed--, available++   (stock returned to pool)
Refunded        → on_hand++                  (stock returned to shelf)
```
Source: [Shopify Inventory States](https://help.shopify.com/en/manual/products/inventory/fundamentals/inventory-states)

### MedusaJS

```
Order placed    → reserved_quantity++
Fulfilled       → stocked_quantity -= reserved, reserved_quantity = 0
Return accepted → stocked_quantity++
```
Source: [MedusaJS Inventory in Flows](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows)

### WooCommerce

```
Order processing → stock_quantity-- (immediate deduction)
Cancelled        → stock_quantity++ (restore)
Refunded         → stock_quantity++ (restore)
```
Source: [WooCommerce Stock Functions](https://woocommerce.github.io/code-reference/files/woocommerce-includes-wc-stock-functions.html)

### Our Engine (Current)

```
Order placed    → quantityReserved++         ✓
Fulfilled       → (nothing)                  ✗ ← BUG-4
Cancelled       → quantityReserved--         ✓ (but no payment refund)
Refunded        → (nothing)                  ✗ ← BUG-1, BUG-2
```

---

## 8. Implementation Plan

### Phase 1: Fix Terminal State Handlers (Day 1)

**File:** `packages/core/src/modules/orders/service.ts`

Expand `changeStatus()` to handle all terminal states:

```typescript
// Handle cancellation AND refund side effects
if (input.newStatus === "cancelled" || input.newStatus === "refunded") {
  // 1. Release inventory reservations
  if (inventory?.release) {
    for (const lineItem of lineItems) {
      await inventory.release({ ... });
    }
  }

  // 2. Refund payment (if captured)
  const paymentIntentId = order.metadata?.paymentIntentId as string | undefined;
  if (paymentIntentId) {
    const payments = this.deps.services.payments as PaymentsServiceLike;
    if (payments?.refund) {
      await payments.refund(paymentIntentId, order.grandTotal, input.reason ?? "order_" + input.newStatus);
    }
  }

  // 3. Void tax
  if (tax?.voidTransaction) {
    await tax.voidTransaction({ transactionId: order.id });
  }
}
```

### Phase 2: Fulfillment Inventory Deduction (Day 2)

**File:** `packages/core/src/modules/fulfillment/service.ts`

Add inventory deduction when fulfillment completes:

```typescript
async fulfillOrder(orderId: string, ctx?: TxContext) {
  // ... existing fulfillment record creation ...

  // After all fulfillment records created, deduct inventory:
  const inventory = this.deps.inventoryService; // add to deps
  for (const lineItem of lineItems) {
    // Decrease on_hand by fulfilled quantity
    await inventory.adjust({
      entityId: lineItem.entityId,
      variantId: lineItem.variantId,
      adjustment: -lineItem.quantity,
      reason: "fulfillment",
      referenceType: "order",
      referenceId: orderId,
    });

    // Release the reservation (reserved → 0 for this quantity)
    await inventory.release({
      entityId: lineItem.entityId,
      variantId: lineItem.variantId,
      quantity: lineItem.quantity,
      orderId,
    });
  }
}
```

**Net effect on fulfillment:**
```
Before: on_hand=100, reserved=5, available=95
After:  on_hand=95,  reserved=0, available=95
```

Available stays the same (correct — the items were already "sold"), but the underlying numbers now accurately reflect physical stock.

### Phase 3: Payment Intent on Orders Schema (Day 2)

**File:** `packages/core/src/modules/orders/schema.ts`

```typescript
export const orders = pgTable("orders", {
  // ... existing columns ...
  paymentIntentId: text("payment_intent_id"),
  paymentMethodId: text("payment_method_id"),
});
```

Update order creation in `checkout.ts` to write these columns directly instead of relying on metadata.

### Phase 4: Marketplace Sub-Order Inventory Sync (Day 3)

**File:** `packages/plugins/plugin-marketplace/src/services/sub-order.ts`

Extend `cancel()` to:
1. Release inventory for the vendor's line items on the parent order
2. Reverse the vendor's balance ledger entries (debit the sale credit, credit back the commission)

**File:** `packages/plugins/plugin-marketplace/src/hooks.ts`

The marketplace plugin should not directly call core inventory. Instead, it should transition the parent order's fulfillment status. Add a hook on sub-order cancellation that checks if ALL sub-orders are cancelled, and if so, cancels the parent order (which triggers the core cancel flow).

### Phase 5: Line Item Fulfillment Status (Day 3)

**File:** `packages/core/src/modules/fulfillment/service.ts`

After creating a fulfillment record for a line item, update `order_line_items.fulfillment_status`:
- `"unfulfilled"` → `"fulfilled"` when fulfillment record created
- This enables partial fulfillment tracking at the line item level

### Phase 6: Stale Reservation Cleanup (Day 4)

Add a scheduled job that scans for orders in "pending" status older than 48 hours and auto-cancels them, releasing inventory and refunding payment.

### Phase 7: Tests (Day 4)

Add integration tests for:
1. Cancel after payment → verify inventory released AND payment refunded
2. Fulfilled → refunded → verify inventory released AND payment refunded
3. Marketplace vendor cancels sub-order → verify parent inventory released
4. Stale order auto-cancel → verify cleanup
5. Fulfillment → verify on_hand decremented, reserved cleared

---

## 9. Key Files

| File | Change |
|------|--------|
| `packages/core/src/modules/orders/service.ts` | Add refund handling, payment refund on cancel/refund |
| `packages/core/src/modules/orders/schema.ts` | Add `paymentIntentId`, `paymentMethodId` columns |
| `packages/core/src/modules/fulfillment/service.ts` | Add inventory deduction after fulfillment |
| `packages/core/src/interfaces/rest/routes/checkout.ts` | Write paymentIntentId to order column |
| `packages/plugins/plugin-marketplace/src/services/sub-order.ts` | Add inventory release + ledger reversal on cancel |
| `packages/plugins/plugin-marketplace/src/hooks.ts` | Add sub-order cancel → parent order sync |
| `apps/runvae/test/08-orders.test.ts` | Add cancel/refund inventory+payment tests |
| `apps/runvae/test/13-marketplace.test.ts` | Add sub-order cancel inventory test |

---

## 10. Risk Assessment

| Bug | Frequency | Financial Impact | Data Integrity |
|-----|-----------|-----------------|----------------|
| BUG-1: Refund no inventory release | Every refund | Lost sales from phantom unavailability | quantityReserved grows unbounded |
| BUG-2: Refund no payment refund | Every refund | Customer charged, chargeback risk | Money trapped |
| BUG-3: Cancel no payment refund | Every cancel post-capture | Customer charged, chargeback risk | Money trapped |
| BUG-4: Fulfillment no inventory deduct | Every fulfillment | quantityOnHand never reflects actual stock | Inventory drift |
| BUG-5: Marketplace cancel no sync | Every vendor cancel | Vendor items permanently reserved | Cross-system inconsistency |

**All 5 bugs compound over time.** A marketplace processing 100 orders/day with a 5% refund rate loses ~5 units of available stock per day. After 6 months, that's ~900 phantom-reserved units across the catalog.
