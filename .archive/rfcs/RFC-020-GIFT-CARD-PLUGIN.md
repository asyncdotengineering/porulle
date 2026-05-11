# RFC-020: Gift Card Plugin

- **Status:** Proposed
- **Author:** Engineering
- **Date:** 2026-03-18
- **Scope:** `packages/plugins/plugin-gift-cards/`
- **Motivation:** Enable stored-value gift cards as a reusable plugin across all starters --- purchased as products, redeemed as partial payment at checkout, with balance tracking, delivery via email, and adversarial-tested concurrency safety
- **Prior art:** Shopify Gift Cards, Medusa Gift Cards, Square Gift Cards
- **Estimated effort:** 4-5 engineering-days

---

## 1. Problem

Gift cards are table-stakes for any commerce platform. Customers expect to:

1. **Purchase** a gift card as a product (for themselves or as a gift)
2. **Receive** a unique code via email with a personalized message
3. **Redeem** the code at checkout to partially or fully cover the order total
4. **Check balance** and view transaction history

UnifiedCommerce has no gift card support. The fashion starter's payment button has a `// TODO: Add this once gift cards are implemented` placeholder.

### 1.1 Why This Is Not a Promotion

| Aspect | Promotion | Gift Card |
|--------|-----------|-----------|
| **Value source** | Store defines a rule | Customer purchases balance |
| **State** | Stateless (code + conditions) | Stateful (balance decrements per use) |
| **Financial classification** | Revenue reduction (discount) | Deferred revenue (liability on the balance sheet) |
| **Lifecycle** | Create → apply → done | Purchase → issue → redeem (n times) → exhaust |
| **Transferability** | Sometimes (codes) | Always (that's the product) |
| **Partial use** | No (all-or-nothing per order) | Yes (remaining balance carries forward) |
| **Refundability** | N/A | Credit back to card balance |

The existing promotions module (`percentage_off_order`, `fixed_off_order`, etc.) cannot model a depleting balance. A gift card is closer to a **payment source** than a discount.

### 1.2 Why a Plugin, Not Core

- Not every store needs gift cards (B2B, marketplaces, appointment-based)
- The feature touches 3 modules (catalog, payments, notifications) --- a plugin composes across these via hooks
- `defineCommercePlugin` already supports schema, routes, hooks, and jobs
- Keeps core lean --- the plugin pattern exists for exactly this kind of vertical feature
- Reusable across starters: fashion, electronics, subscription boxes

---

## 2. Design

### 2.1 Concept Model

```
┌──────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Customer A  │──buy──▶│  Gift Card       │──send─▶│  Recipient B     │
│  (purchaser) │       │  code: ABCD-1234 │       │  (or same person)│
└──────────────┘       │  balance: 15000  │       └────────┬─────────┘
                       │  currency: EUR   │                │
                       └────────┬─────────┘                │
                                │                    redeem at checkout
                                ▼                          │
                       ┌──────────────────┐                │
                       │  Transactions    │◀───────────────┘
                       │  -5000 (order X) │
                       │  +5000 (refund)  │
                       │  -3000 (order Y) │
                       └──────────────────┘
```

### 2.2 Data Model

**Table: `gift_cards`**

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK, default random | |
| `code` | text | UNIQUE, NOT NULL | 16-char alphanumeric, generated |
| `initial_amount` | integer | NOT NULL | In minor units (cents) |
| `balance` | integer | NOT NULL, CHECK >= 0 | Current remaining balance |
| `currency` | text | NOT NULL | ISO 4217 (EUR, USD) |
| `status` | text | NOT NULL | `active`, `disabled`, `exhausted` |
| `purchaser_id` | text | nullable | Customer who bought it |
| `recipient_email` | text | nullable | Delivery target |
| `sender_name` | text | nullable | For personalized email |
| `personal_message` | text | nullable | Gift message |
| `source_order_id` | text | nullable | Order that created this card |
| `expires_at` | timestamp(tz) | nullable | Optional expiry |
| `version` | integer | NOT NULL, default 0 | Optimistic concurrency |
| `metadata` | JSONB | default {} | |
| `created_at` | timestamp(tz) | NOT NULL | |
| `updated_at` | timestamp(tz) | NOT NULL | |

**Indexes:**
- `idx_gift_cards_code` on `code` (already unique)
- `idx_gift_cards_purchaser` on `purchaser_id`
- `idx_gift_cards_status` on `status`

**Table: `gift_card_transactions`**

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK, default random | |
| `gift_card_id` | UUID | FK → gift_cards.id, CASCADE | |
| `type` | text | NOT NULL | `debit`, `credit`, `refund` |
| `amount` | integer | NOT NULL | Always positive |
| `balance_after` | integer | NOT NULL | Snapshot after this txn |
| `order_id` | text | nullable | Which order caused this |
| `note` | text | nullable | |
| `created_at` | timestamp(tz) | NOT NULL | |

**Indexes:**
- `idx_gc_txn_card` on `gift_card_id`
- `idx_gc_txn_order` on `order_id`

### 2.3 Code Generation

Gift card codes must resist brute-force attacks. Requirements:

- **Format:** `XXXX-XXXX-XXXX-XXXX` (16 alphanumeric chars, uppercase, no ambiguous chars: `0O1IL`)
- **Charset:** `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (30 chars)
- **Entropy:** 30^16 = ~7.2 × 10^23 possibilities --- brute-force infeasible
- **Generation:** `crypto.getRandomValues()` (not `Math.random()`)
- **Uniqueness:** DB unique constraint + retry on collision (collision probability ~0)
- **Lookup:** Case-insensitive, strip hyphens before query

### 2.4 Balance Deduction (Concurrency Safety)

Uses the same `SELECT FOR UPDATE` + optimistic versioning pattern as inventory:

```typescript
async debitWithLock(
  code: string,
  amount: number,
  orderId: string,
  ctx: TxContext,
): Promise<Result<{ balanceAfter: number }>> {
  // 1. Lock the row
  const card = await db.select()
    .from(giftCards)
    .where(eq(giftCards.code, normalizeCode(code)))
    .for("update")
    .then(rows => rows[0]);

  if (!card) return Err("GIFT_CARD_NOT_FOUND");
  if (card.status !== "active") return Err("GIFT_CARD_INACTIVE");
  if (card.expiresAt && card.expiresAt < new Date()) return Err("GIFT_CARD_EXPIRED");
  if (card.currency !== ctx.currency) return Err("CURRENCY_MISMATCH");
  if (card.balance < amount) return Err("INSUFFICIENT_BALANCE");

  // 2. Debit
  const balanceAfter = card.balance - amount;
  await db.update(giftCards)
    .set({
      balance: balanceAfter,
      status: balanceAfter === 0 ? "exhausted" : "active",
      version: card.version + 1,
      updatedAt: new Date(),
    })
    .where(eq(giftCards.id, card.id));

  // 3. Record transaction
  await db.insert(giftCardTransactions).values({
    giftCardId: card.id,
    type: "debit",
    amount,
    balanceAfter,
    orderId,
  });

  return Ok({ balanceAfter });
}
```

**Compensation (refund/cancel):**
```typescript
async creditWithLock(
  code: string,
  amount: number,
  orderId: string,
  note: string,
  ctx: TxContext,
): Promise<Result<{ balanceAfter: number }>> {
  // Same SELECT FOR UPDATE pattern
  // Credit cannot exceed initial_amount (guard against inflation attack)
  // Sets status back to "active" if was "exhausted"
}
```

### 2.5 Checkout Integration

Gift cards integrate into the checkout pipeline via `checkout.beforeCreate` hook.

**The timing problem:** Core hooks run in this order:
1. `resolveCurrentPrices` → sets `subtotal`
2. `applyPromotionCodes` → sets `discountTotal`
3. `calculateTax` → sets `taxTotal`
4. `calculateShipping` → sets `shippingTotal`
5. `authorizePayment` → creates payment intent for `total`
6. Plugin hooks (`checkout.beforeCreate`) → run here

If the gift card hook runs **after** `authorizePayment`, the payment intent was already created for the full amount. Two approaches:

**Option A: Reduce total before payment (requires core change)**
Add a `checkout.beforePayment` hook slot between `calculateShipping` and `authorizePayment`. The gift card hook runs here, sets `data.giftCardDeduction`, and `authorizePayment` sees a reduced total.

**Option B: Split payment model (no core change)**
The gift card deduction runs in `checkout.beforeCreate` (after payment auth). It:
1. Debits the gift card balance
2. Stores the deduction in `data.metadata.giftCardDeduction`
3. If the gift card covers the full amount, the payment adapter receives amount = 0 (most adapters handle this as a no-charge)
4. If partial, the payment adapter charges only the remainder

**Recommendation: Option A.** It's a single-line change in the checkout hook pipeline (insert a hook resolution point), and it keeps the payment intent amount correct from the start. This avoids the "authorize $100 then only capture $50" complexity.

**Core change required:**
```typescript
// packages/core/src/hooks/checkout.ts — add between calculateShipping and authorizePayment
...kernel.hooks.resolve("checkout.beforePayment"),  // ← new hook slot
```

**Plugin hook implementation:**
```typescript
{
  key: "checkout.beforePayment",
  handler: async ({ data, context }) => {
    const codes = data.metadata?.giftCardCodes as string[] | undefined;
    if (!codes?.length) return data;

    let remaining = data.total;
    const deductions: Array<{ code: string; amount: number }> = [];

    for (const code of codes) {
      if (remaining <= 0) break;
      const deductAmount = Math.min(remaining, await getBalance(code));
      const result = await debitWithLock(code, deductAmount, data.orderId, context);
      if (result.ok) {
        deductions.push({ code, amount: deductAmount });
        remaining -= deductAmount;
      }
    }

    return {
      ...data,
      giftCardTotal: deductions.reduce((sum, d) => sum + d.amount, 0),
      total: Math.max(0, remaining),
      metadata: { ...data.metadata, giftCardDeductions: deductions },
    };
  },
}
```

**Compensation on checkout failure:**
```typescript
{
  key: "checkout.afterCreate",
  handler: async ({ data, result, context }) => {
    // If order creation failed, credit back all gift card deductions
    if (!result) {
      const deductions = data.metadata?.giftCardDeductions as Array<{ code: string; amount: number }> | undefined;
      for (const d of deductions ?? []) {
        await creditWithLock(d.code, d.amount, data.orderId, "Checkout failed — balance restored", context);
      }
    }
  },
}
```

### 2.6 Purchase Flow

When a customer buys a gift card product:

1. **Catalog:** A product with `type: "gift_card"` and `metadata.isGiftCard: true` exists in the catalog
2. **Checkout:** Normal checkout flow processes the order
3. **AfterCreate hook:** The plugin's `checkout.afterCreate` hook detects gift card line items and:
   - Generates a unique code (`crypto.getRandomValues`)
   - Creates a `gift_cards` row with `initial_amount = balance = lineItem.unitPrice * quantity`
   - Enqueues a `gift-card.deliver` job to send the code via email
4. **Job handler:** Sends an email to `recipientEmail` with the code, amount, sender name, and personal message

### 2.7 API Routes

All routes use the `router()` builder pattern.

| Method | Path | Auth | Permission | Description |
|--------|------|------|------------|-------------|
| `POST` | `/api/gift-cards` | Yes | `gift-cards:admin` | Create a gift card manually (admin) |
| `GET` | `/api/gift-cards` | Yes | `gift-cards:admin` | List all gift cards (admin) |
| `GET` | `/api/gift-cards/{id}` | Yes | `gift-cards:admin` | Get gift card details + transactions |
| `POST` | `/api/gift-cards/{id}/disable` | Yes | `gift-cards:admin` | Disable a gift card |
| `POST` | `/api/gift-cards/{id}/adjust` | Yes | `gift-cards:admin` | Manual balance adjustment |
| `POST` | `/api/gift-cards/check-balance` | No | — | Check balance by code (public) |
| `GET` | `/api/me/gift-cards` | Yes | — | List customer's purchased gift cards |

### 2.8 Refund Integration

When an order paid (partially) with a gift card is refunded:

1. The refund hook detects `order.metadata.giftCardDeductions`
2. For each deduction, calls `creditWithLock` to restore balance
3. Sets card status back to `active` if it was `exhausted`
4. Records a `refund` transaction with the `orderId`

---

## 3. File Structure

```
packages/plugins/plugin-gift-cards/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    — defineCommercePlugin entry + giftCardPlugin(options)
│   ├── schema.ts                   — gift_cards + gift_card_transactions tables
│   ├── types.ts                    — shared TypeScript types
│   ├── code-generator.ts           — crypto-safe code generation
│   ├── services/
│   │   ├── gift-card-service.ts    — CRUD + balance operations (debitWithLock, creditWithLock)
│   │   └── gift-card-repository.ts — Drizzle queries + SELECT FOR UPDATE
│   ├── routes/
│   │   ├── admin.ts                — admin CRUD + adjustments (router builder)
│   │   ├── public.ts               — balance check (router builder)
│   │   └── customer.ts             — /me/gift-cards (router builder)
│   └── hooks/
│       ├── checkout-deduction.ts   — checkout.beforePayment hook
│       ├── checkout-issuance.ts    — checkout.afterCreate hook (issue cards for gift card products)
│       └── refund-credit.ts        — order refund compensation
└── test/
    ├── code-generator.test.ts      — entropy, format, no-ambiguous-chars
    ├── balance-operations.test.ts  — debit, credit, concurrent debit (double-spend prevention)
    ├── checkout-flow.test.ts       — full checkout with gift card, partial payment, full payment
    ├── purchase-flow.test.ts       — buying a gift card product → code generated → email enqueued
    └── adversarial.test.ts         — brute-force, negative amounts, currency mismatch, expired cards
```

---

## 4. Plugin Options

```typescript
import { giftCardPlugin } from "@unifiedcommerce/plugin-gift-cards";

export default defineConfig({
  plugins: [
    giftCardPlugin({
      codeFormat: "XXXX-XXXX-XXXX-XXXX",  // default
      defaultExpiry: null,                  // no expiry by default
      maxBalancePerCard: 100_000_00,        // EUR 100,000.00 cap
      emailTemplate: "gift-card-delivery",  // template name for email service
      allowPartialRedemption: true,         // default true
      productType: "gift_card",             // entity type that triggers issuance
    }),
  ],
});
```

---

## 5. Adversarial Test Checklist

These tests must pass before the plugin ships.

### 5.1 Concurrency & Double-Spend

| # | Test | Expected |
|---|------|----------|
| 1 | Two concurrent debits for the same code, total exceeding balance | Exactly one succeeds, one gets `INSUFFICIENT_BALANCE` |
| 2 | Debit + disable race on same card | Debit fails with `GIFT_CARD_INACTIVE` or succeeds before disable |
| 3 | 10 concurrent partial debits on a card with balance = sum of all | All succeed, final balance = 0, no negative |
| 4 | Debit during checkout failure → compensation credits back | Balance restored to pre-checkout value |

### 5.2 Input Validation

| # | Test | Expected |
|---|------|----------|
| 5 | Negative debit amount | 400 — amount must be positive |
| 6 | Zero debit amount | 400 — amount must be > 0 |
| 7 | Debit amount exceeding balance | 409 — `INSUFFICIENT_BALANCE` |
| 8 | Credit that would exceed `initial_amount` | Capped at `initial_amount` (no inflation) |
| 9 | Currency mismatch (card EUR, checkout USD) | 409 — `CURRENCY_MISMATCH` |
| 10 | Expired card redemption | 409 — `GIFT_CARD_EXPIRED` |
| 11 | Disabled card redemption | 409 — `GIFT_CARD_INACTIVE` |
| 12 | Non-existent code | 404 — `GIFT_CARD_NOT_FOUND` |

### 5.3 Code Security

| # | Test | Expected |
|---|------|----------|
| 13 | Generated codes use only allowed charset (no 0, O, 1, I, L) | All chars in `ABCDEFGHJKMNPQRSTUVWXYZ23456789` |
| 14 | Code lookup is case-insensitive + strips hyphens | `abcd-1234-efgh-5678` matches `ABCD1234EFGH5678` |
| 15 | Balance check endpoint rate-limited (5 req/min per IP) | 429 after 5 rapid requests |
| 16 | Code format has sufficient entropy (30^16 > 10^23) | Statistical test: 10000 codes, zero collisions |

### 5.4 Financial Integrity

| # | Test | Expected |
|---|------|----------|
| 17 | Sum of all transactions = `initial_amount - balance` for any card | Invariant holds after random operation sequence |
| 18 | Gift card purchase creates card with correct amount | `initial_amount = lineItem.unitPrice * quantity` |
| 19 | Full refund of order with gift card payment → balance fully restored | Balance = pre-order balance |
| 20 | Partial refund → proportional gift card credit | Gift card portion credited, payment adapter refunds the rest |
| 21 | Buying a gift card with a gift card | Allowed (no self-referential block — valid commerce use case) |
| 22 | `balance` column CHECK constraint prevents negative | DB-level constraint, not just app-level |

### 5.5 Edge Cases

| # | Test | Expected |
|---|------|----------|
| 23 | Gift card covers exact order total (zero payment to adapter) | Order succeeds, payment adapter receives amount=0 |
| 24 | Multiple gift cards on one order | Each debited in sequence, total deduction = sum |
| 25 | Same gift card used on two orders (partial each time) | Both succeed if balance sufficient |
| 26 | Gift card with 1 cent balance, order = 1 cent | Card exhausted, status → `exhausted` |
| 27 | Admin manual adjustment (positive) | Balance increases, transaction recorded |
| 28 | Admin manual adjustment (negative, would go below 0) | Capped at 0, not negative |

---

## 6. Core Change Required

One hook slot addition in `packages/core/src/hooks/checkout.ts`:

```diff
  // After calculateShipping, before authorizePayment
+ ...kernel.hooks.resolve("checkout.beforePayment"),
```

This is a non-breaking, additive change. No existing behavior is modified. The hook slot is simply empty if no plugin registers for it.

---

## 7. Verification

1. `npx tsc --noEmit` — zero type errors in plugin + core
2. `bun test` in `packages/plugins/plugin-gift-cards/` — all 28+ adversarial tests pass
3. Concurrent double-spend test: two requests for same code → one succeeds, one 409
4. Full checkout with gift card: order total reduced, balance debited, transaction recorded
5. Gift card purchase: product checkout → code generated → email job enqueued
6. Refund: gift card balance restored, transaction type = `refund`
7. `GET /api/doc` shows gift card routes under correct tags
8. Fashion starter checkout page can apply gift card codes

---

## 8. Starter Integration

After the plugin ships, the fashion starter wires it in:

```typescript
// apps/fashion-starter/commerce.config.ts
import { giftCardPlugin } from "@unifiedcommerce/plugin-gift-cards";

export default defineConfig({
  plugins: [
    giftCardPlugin(),
  ],
  // ...
});
```

The checkout UI adds a "Gift Card" input field that passes codes via `metadata.giftCardCodes` in the checkout payload. The `// TODO: Add this once gift cards are implemented` placeholder in `payment-button/index.tsx` gets replaced with the actual balance display.

---

## 9. Estimated Effort

| Phase | Tests | Implementation | Total |
|-------|-------|----------------|-------|
| Schema + code generator | 0.5d | 0.5d | 1d |
| Balance operations + concurrency | 0.5d | 1d | 1.5d |
| Checkout integration (hook + deduction + compensation) | 0.5d | 0.5d | 1d |
| Purchase flow (issuance + email job) | 0.25d | 0.25d | 0.5d |
| Admin + public routes | 0.25d | 0.25d | 0.5d |
| Adversarial tests + hardening | 0.5d | — | 0.5d |
| **Total** | **2.5d** | **2.5d** | **5d** |
