# Commerce-principles deviation audit (vs Medusa/Shopify/Vendure) — findings index

## Cart & line-item model
- CRITICAL: cart.addItem has NO price-resolution in core — `unitPriceSnapshot ?? 1000` fallback; POS plugin never supplies price → snapshots $10. (starter works around it via cart.beforeAddItem hook; core ships none.)
- HIGH: checkout re-resolves prices, ignoring cart snapshot → two sources of truth, no reconciliation (Vendure changedPriceHandlingStrategy missing).
- HIGH: no cart-level promotion/adjustment surface — can't preview discount on cart (confirms why Slice A had to track codes storefront-side).
- HIGH: claimForCheckout is a one-way door — failed checkout strands cart in `checking_out` forever; recover() refuses that status.
- MED: modifiers/addons = opaque metadata blob, not first-class component lines (no parentLineItemId).
- MED: no buyer identity/address on cart (tax/shipping preview impossible pre-checkout).
- LOW: dead access.ts encodes the pre-fix exploitable ownership pattern.

## Orders, totals, refunds & state
- HIGH: manual order (POST /api/orders) trusts caller taxTotal/shippingTotal/grandTotal (only subtotal re-derived when untrusted); orders:manage is broad. Medusa/Vendure always derive.
- MED-HIGH: grandTotal never cross-footed against components even on trusted path; totals stored as independent unconstrained columns.
- HIGH: cancelling a partially-fulfilled order over-refunds (refunds full remaining captured, no proration for shipped goods).
- HIGH: line-item edit can shrink grandTotal below amountCaptured with NO auto-refund (Vendure OrderModifier auto-refunds delta).
- MED: refundLines per-call proportional rounding can drift sum-of-partials off line value.
- MED: single status axis conflates fulfillment + financial/refund state (Shopify/Medusa split them).
- LOW-MED: order-level discount frozen across edits, not re-validated against eligibility.

## Promotions & discounts
- CRITICAL: per-line discount never attributed (lineItem.discountAmount stays 0) → root cause of tax-overcharge + refund-overpay on discounted orders. Empirically confirmed by shipped test (taxTotal=700 on discounted $70 order; correct=665).
- CRITICAL/HIGH: tax computed on PRE-discount base in runtime-rate + adapter paths (only calculateByClasses subtracts orderDiscount). Overcharges tax by the discount rate on every discounted order (for the common runtime/adapter config).
- HIGH: tax-before-shipping → appliesToShipping never fires (shippingAmount always 0). [CONVERGENT with tax agent + my finding]
- HIGH: refund reuses the always-0 discountAmount → partial refunds overpay on discounted orders.
- MED: no combinability/exclusivity model — promotions stack additively unbounded.
- MED: usage-limit TOCTOU race (check then post-hoc recordUsage, not atomic).
- LOW: buy_x_get_y single eligibility set (no distinct buy vs get).

## Tax & shipping
- CRITICAL: tax-before-shipping ordering (shippingAmount=0 at tax time) — appliesToShipping dead. [CONVERGENT ×3]
- HIGH: tax classes bypass address/jurisdiction entirely (any class → flat org-wide rate, loses per-state/country); also skip shipping tax.
- HIGH: no tax-inclusive pricing anywhere (VAT/GST markets blocked). [CONVERGENT with pricing agent]
- MED: wildcard "*" country rate stacks with specific-country rate (double tax) instead of fallback.
- MED: targeted promo value-share-prorated across all lines' tax base (wrong when mixed tax classes).
- LOW: shipping rate matching is cheapest-first not priority-ranked (no rate.priority); fromAddress unused; rounding OK.

## Pricing & money math
- CRITICAL: cart unitPriceSnapshot not server-resolved — `?? 1000` fallback; no core/reference hook. [CONVERGENT with cart agent]
- HIGH: money columns are int32 (~$21.47M cap) — high-value B2B line overflows to raw Postgres error, no clean validation.
- HIGH: pricing API schemas accept floats (example 29.99) despite minor-units-integer invariant; no .int() guard.
- MED: modifier type vs value sign unvalidated (markup w/ negative value acts as discount).
- MED: compareAtAmount referenced in types but no column — dead field, UI silently gets null.
- MED: no tax-inclusive mode (dup). LOW: no 0/3-decimal currency handling (JPY).
- POSITIVE: checkout re-resolves prices server-side (not a fraud vector); tax bps rounding w/ remainder correct.

## Sellable-entity & catalog model
- SCHEMA VERDICT: entity/variant/price/inventory split is sound + faithful to Product/ProductVariant. The WIRING deviates.
- CRITICAL: fulfillment dispatch ignores EntityConfig.fulfillment — hardcoded entityType ternary (digitalDownload/course/internalAsset→else physical). gift_card configured fulfillment:"digital" → silently PHYSICAL fulfillment. Per-type config is dead.
- CRITICAL: appointments/service vertical bypasses sellableEntities entirely (own tables/payment/booking, not through cart/checkout/orders); registered "appointment" fulfillment strategy is unreachable dead code. Two incompatible sellable models.
- HIGH: no sellability gate — cart.addItem never checks status (draft/discontinued/archived) or isVisible; draft/discontinued items purchasable.
- MED: entity.type not validated vs config.entities (typo silently skips custom-field validation + fulfillment).
- MED: variant option combo uniqueness + completeness only enforced on quickCreate/bulk, NOT base createVariant.
- MED/HIGH: prices table has no DB unique on natural key → concurrent setBasePrice check-then-act race → duplicate prices.
- MED: pricing falls back to untyped entity.metadata.basePrice (bypasses pricing module).
- LOW: "course" sellable type has no reference plugin (vaporware).
