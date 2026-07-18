# Porulle Commerce-Principles Deviation Audit — 2026-07-18

Eight parallel domain audits of the porulle engine, each cross-checked against **Medusa v2, Shopify, and Vendure** (grounded in their docs / DeepWiki). Scope: the sellable-entity abstraction, pricing/money math, cart, promotions, tax/shipping, orders/totals/refunds, inventory/fulfillment, checkout/payments. Every claim below is cited `file:line` in the per-domain reports; this is the ranked synthesis.

## Verdict

The **schemas and the isolated primitives are sound** — the sellable-entity/variant split mirrors Medusa/Vendure, `available = onHand − reserved` is correct, reserve/release/adjust are properly `SELECT … FOR UPDATE` + atomic SQL, checkout re-resolves prices server-side (no price-tamper fraud vector), tax bps rounding uses remainder correction, and the Stripe webhook dedup is Medusa/Stripe-grade.

**But the composition is not commerce-sound as wired.** The pricing/tax/discount pipeline mis-orders and mis-attributes in ways that move real money wrong, and the "sell anything from one entity" promise is broken at the two layers that most need polymorphism (fulfillment dispatch, inventory tracking). Multiple of the worst findings are **convergent** — found independently by 2–3 agents and confirmed by porulle's own passing tests.

## Convergent CRITICAL findings (highest confidence — multiple agents / proven by tests)

| # | Finding | Impact | Confirmed by |
|---|---|---|---|
| C1 | **Tax computed before shipping** — `calculateTax` runs before `calculateShipping` (checkout route 162-169); `shippingAmount` is always `0` at tax time. | `appliesToShipping` tax rates are **dead** — shipping tax never collected. Compliance risk. | promotions + tax + checkout agents (×3) |
| C2 | **Per-line discount never attributed** — `lineItem.discountAmount` set to 0 and never updated; promotions only produce a cart-level lump. | **Tax over-charged on every discounted order** (runtime-rate/adapter paths tax the pre-discount base) **and partial refunds over-pay** (refund math subtracts a 0 discount). | promotions + tax agents; **proven** by shipped test `taxTotal=700` where correct = `665` |
| C3 | **Cart price not server-resolved** — `unitPriceSnapshot ?? 1000` fallback; no core/reference `beforeAddItem` hook (only a docs example). | Any consumer/POS without the hook silently prices every line at **$10**. Cart shows one number, checkout charges another. | cart + pricing agents (×2) |
| C4 | **Fulfillment dispatch ignores `EntityConfig.fulfillment`** — hardcoded `entityType` ternary; a `gift_card` configured `fulfillment:"digital"` falls through to **physical**. | The per-type polymorphism the whole design rests on is dead config at the fulfillment layer. | sellable-entity agent |

## HIGH findings

- **Manual/draft order (`POST /api/orders`) trusts caller `taxTotal`/`shippingTotal`/`grandTotal`** — only `subtotal` is re-derived (untrusted path); `orders:manage` is broad. Medusa/Vendure always derive. *(This is the Slice-D gap.)* — orders agent
- **No `grandTotal` cross-footing invariant** even on the trusted path; totals are independent unconstrained columns. One hook regression → silently wrong total on every order. — orders agent
- **Partial-fulfillment cancel over-refunds** — refunds the full remaining captured balance with no proration for already-shipped goods. Direct dollar loss. — orders agent
- **Line-edit shrinks `grandTotal` below `amountCaptured` with no auto-refund** (Vendure's OrderModifier auto-refunds the delta). — orders agent
- **`claimForCheckout` is a one-way door** — any post-claim failure (declined card!) permanently strands the cart in `checking_out`; `recover()` refuses that status. Deterministic on the most common failure mode. — cart + checkout agents (×2)
- **Money columns are int32** (~$21.47M) — a high-value B2B line overflows to a raw Postgres error, no clean validation. — pricing agent
- **Pricing API accepts floats** (`amount` example `29.99`) despite the minor-units-integer invariant; no `.int()` guard. — pricing agent
- **Tax classes bypass jurisdiction/address entirely** — any active class → one flat org-wide rate, loses per-state/country and shipping tax. Landmine for real US/EU tax. — tax agent
- **No tax-inclusive pricing** anywhere — blocks VAT/GST markets that legally require inclusive display. — tax + pricing agents (×2)
- **Non-stocked types not exempt from inventory** — no `tracksInventory` flag; every course/digital/service SKU needs a fake warehouse row to be sellable (proven by the repo's own test fixture). — inventory + sellable-entity agents (×2)
- **Reservation leak on partial mid-order failure** — `reserveInventoryStep`'s internal loop isn't compensated; earlier lines' reservations strand permanently, corrupting `available`. — inventory agent
- **No sellability gate** — `cart.addItem` never checks entity/variant `status`/`isVisible`; draft/discontinued items are purchasable. — sellable-entity agent
- **Appointments/service vertical bypasses `sellableEntities` entirely** — parallel tables + payment + booking; the registered `"appointment"` fulfillment strategy is unreachable dead code. Two incompatible sellable models. — sellable-entity agent

## MEDIUM findings

- `deductForFulfillment` is the one inventory mutator **not** row-locked/atomic (concurrent fulfill of the same SKU can clobber the decrement). — inventory
- Partial-fulfillment quantities never reach inventory — `createFulfillment` tracks partial qty cosmetically; the deduction path is all-or-nothing per line. — inventory
- No restock on refund of a fulfilled line — inventory drifts short after every physical return. — inventory
- `matchRuntimeRates` wildcard `"*"` country rate **stacks** with a specific-country rate (double tax) instead of being a fallback. — tax
- Targeted promo (one SKU) value-share-prorated across all lines' tax base (wrong with mixed tax classes). — tax
- Idempotency guard is order-row-only, not side-effect-only — a race-loser still re-runs capture + reserve; and Stripe intent creation passes **no** `idempotencyKey`. — checkout
- Promotions stack additively with no combinability/exclusivity model; usage-limit has a TOCTOU race. — promotions
- Prices table has no DB unique on its natural key → concurrent `setBasePrice` check-then-act race → duplicate prices. — sellable-entity
- Variant option-combo uniqueness + completeness only enforced on 2 of 3 creation paths. — sellable-entity
- Modifiers/addons are a plugin-specific third data shape (not entities, not variants), duplicating the core `priceModifiers` engine. — sellable-entity + cart
- Single order `status` axis conflates fulfillment + financial/refund state (Shopify/Medusa split them); `lifetimeSpend` doesn't net out line refunds. — orders
- Order-level discount frozen across edits, not re-validated against eligibility. — orders
- `compareAtAmount` referenced in types but has no column (dead field). Modifier `type` vs `value` sign unvalidated. — pricing

## LOW findings
- `stockPolicy:"backorder"` is a no-op (only `"reserve"` branches). — inventory
- `buy_x_get_y` single eligibility set (no distinct buy vs get). — promotions
- Shipping rate matching is cheapest-first, no `rate.priority`; `fromAddress` unused. — tax
- Dead `access.ts` encodes the pre-fix exploitable cart-ownership pattern; orphaned `capturePayment`/`reserveInventory` AfterHooks. — cart + checkout
- No 0/3-decimal currency handling (JPY). — pricing

## Remediation roadmap (proposed order — by money-impact × blast-radius)

**Wave 1 — the pricing composition (money-correctness; also unblocks Slice D):**
1. Reorder `calculateShipping` before `calculateTax` (fix C1) + export `recalculateTotals`.
2. Attribute discounts per line — have `promotions.applyPromotions` return a per-line breakdown; populate `lineItem.discountAmount` (fixes C2's tax over-charge + refund over-pay). Update the test that currently asserts the bug.
3. **Extract `computeOrderPricing(services, PricingInput) → PricingBreakdown`** from the (now-corrected) 4 pricing hooks; checkout and the new **`POST /api/orders/quote`** both call it. Golden test: `quote == checkout == placed-order` totals. → **This is Slice D's engine.**
4. Add a `grandTotal` cross-footing invariant assertion in `orders.create`/`recalcOrderTotals`.

**Wave 2 — sellable-entity integrity:** fix C3 (server-resolve cart price, drop `?? 1000`), C4 (fulfillment dispatch via `config.entities[type].fulfillment`), non-stocked `tracksInventory` flag, sellability gate in `addItem`.

**Wave 3 — resilience & correctness:** cart claim release path, reservation-leak compensation, `deductForFulfillment` locking, tax-class jurisdiction composition, int32→bigint money, `.int()` API guards, tax-inclusive support.

Each wave is one or more patch releases (0.10.x). Wave 1 is in progress as the Slice-D quote engine.
