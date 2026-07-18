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

## ROUND 2 (adversarial) — async & integration
- HIGH: Shopify per-store webhook has NO shop-domain binding — HMAC verified against app-wide clientSecret only; never checks X-Shopify-Shop-Domain vs store.storeDomain → cross-tenant webhook forgery (incl. auto-approved refund path). (adapter-shopify verifyWebhook)
- MED-HIGH: outbound connector calls have no timeout + reaper blindly flips stuck jobs pending→ retry with no cancel → double order-push / double inventory-write (WooCommerce pushOrder has no idempotency key). (jobs/reaper.ts, runner.ts)
- MED: notifications plugin logs status:"sent" for channel:"email" but there's NO EmailAdapter — silent false-success on transactional emails.
- LOW-MED: customers repository update/delete/address ops have no org predicate at SQL layer (latent cross-tenant PII write footgun; same pattern webhooks repo was hardened for).
- NOTE: prior VAPT hardening verified live (webhook org-scoping, timing-safe HMAC, processedWebhookEvents dedup) — not re-reported.

## ROUND 2 (adversarial) — auth, multi-tenancy & org isolation
- CRITICAL (EMPIRICALLY REPRODUCED): boot org-resolution globals (_bootDefaultOrgId, _bootStrictOrgResolution in auth/org.ts + strict-org-resolution.ts) are PROCESS-GLOBAL, set by every createCommerce/createKernel, consulted BEFORE per-call config → two CommerceConfig in one process (multi-tenant host / test runner) cross-contaminate: tenant A's actor-less requests (anon carts, webhooks, jobs) resolve into tenant B's default org + B's strict setting. Fix: AsyncLocalStorage per instance (pattern already used in plugin manifest).
- HIGH: RBAC canGrantRole uses flat 3-bucket rank (owner=3/admin=2/custom=1) not permission-subset → any custom role with staff:manage can grant ANY other custom role (vertical priv-esc). Fix: Vendure-style subset check.
- MED: admin/staff.ts uses RAW kernel.database.db (opts out of createScopedDb); mutating update/delete filter by id only (TOCTOU). Scoped-db blind to org-less child tables (cart_line_items) — repo methods take bare id, safe only by caller discipline.
- MED: authenticated-but-unaffiliated users silently pooled into default org; strictOrgResolution defaults FALSE. Fix: default strict=true when storeResolver/apiKeyScopes configured; 403 on failed resolution.
- LOW-MED: RouteChain.permission() (used by ALL plugins) only checks exact + *:* , NOT resource:* wildcard (requirePerm/assertPermission DO) → inconsistent, pressures *:* over-grants. API-key configId resolution = naive prefix startsWith (overlap ambiguity).

## ROUND 2 (adversarial) — supporting modules (analytics/audit/documents/media/search/settings)
- CRITICAL: analytics Cube engine (DrizzleAnalyticsAdapter) has ZERO org scoping — admin/staff of ANY org see every org's revenue/orders/customers via analytics.query()/getDashboard(). (RetailReportsEngine right next to it DOES scope — inconsistency.)
- CRITICAL: search has NO tenant isolation in the adapter contract; both shipped adapters (meilisearch, pg-search) share ONE global index; GET /search is UNAUTHENTICATED → anonymous cross-tenant catalog leak. Also raw entity.metadata rides into hits unredacted.
- HIGH: refunds/undo NOT audited; auditMiddleware (audit-by-default) is NEVER mounted anywhere → audit covers low-risk edits, misses refunds/settings/permissions.
- HIGH: analytics revenue measure sums ALL orders (incl. refunded/cancelled); canned reports exclude cancelled/voided but NOT refunded → overstated revenue + tax owed.
- HIGH: media "signed" URLs don't expire on local-storage + default-R2 adapters (decorative ?expiresIn, never enforced) — only S3 real-presigns. Self-hosted default = URLs valid forever.
- HIGH: policies settings group (refundDailyCap, refundUndoWindowMinutes) accepts unvalidated record → settings:manage holder can neuter fraud controls, unlogged.
- MED: invoice email accepts arbitrary recipient (spam/phishing relay via store's domain); invoice content not frozen at issuance (re-renders live, refund not reflected on fiscal number).
- MED: unknown settings groups get zero validation (invoicePrefix free-form into fiscal number).
- POSITIVE: media IDOR/path-traversal fixed (prior VAPT); documents access-control sound.

## ROUND 2 (adversarial) — re-verify Round 1 + NEW
- All R1 CRITICAL/HIGH CONFIRMED from source (incl. proven taxTotal=700 test). Calibration: R1 trustworthy on mechanism, slightly under-scopes blast radius.
- N3 (sharpen C1): tax CLASSES path (calculateByClasses) has NO appliesToShipping/shipping-tax concept AT ALL → reordering hooks fixes only runtime-rate path; class-path orgs never tax shipping even after reorder. Needs its own fix (add appliesToShipping to TaxClass).
- N7 (sharpen C2): ALL non-class tax paths ignore orderDiscount (matchRuntimeRates fixed by me; taxjar + tax-manual adapters still ignore it).
- N1 (widen C3): cart price override UNREACHABLE via REST — AddCartItemBodySchema has no unitPriceSnapshot field; Zod strips it → EVERY HTTP cart line prices at $10, not just hook-less consumers.
- N2 (widen C4): shipping/calculator.ts:81 reads config.entities[type].fulfillment with DIFFERENT vocabulary than fulfillment dispatch → two modules disagree.
- N4: inventory.release() has NO per-order reservation ledger → cleanup release for a line this order never reserved decrements SHARED quantityReserved → wipes a DIFFERENT concurrent order's reservation (cross-order oversell).
- N5: completeCheckout failure handler never checks orders.changeStatus Result.ok → cleanup failure silently swallowed.
- N6: cancel-side-effect release loop aborts early on first error → later lines never released.
- N9: prices table has no natural-key unique index (only id PK) → concurrent setBasePrice duplicate prices.

## ROUND 2 (adversarial) — plugin invariant compliance
- CRITICAL: procurement (GRN receive) + warehouse (transfer/wastage/reconciliation) NEVER mutate inventory_levels — paper-only; received/moved/written-off stock never becomes real sellable stock.
- CRITICAL: marketplace child tables (vendorPayouts/subOrders/balances/commissionRules/disputes/returns) have NO organizationId → scoped-db proxy silently no-ops → cross-tenant read/mutate by UUID.
- CRITICAL: marketplace runPayoutCycle unlocked + no unique (vendor,period) → double payout on concurrent/retried run.
- HIGH: loyalty redeemPoints/redeemOffer call .for("update") with NO enclosing tx → lock is a no-op → lost-update double-spend of points / over-redeem capped offers.
- HIGH: loyalty accrual hook no idempotency + no unique (org,orderId) → double-accrual on retry.
- HIGH: layaway addPayment unlocked read-modify-write + no payment idempotency → double core-order creation + double inventory release.
- HIGH: pos transaction.complete() + shift cash events not org-scoped (child tables lack organizationId) → cross-org force-complete / cash-drawer tamper by UUID.
- MED: gift-cards checkout deduction hook no idempotency key → double-deduct on retried checkout; pos-restaurant table.clear deletes before org check.
- COMPLIANT (cleared): gift-cards money+locking, loyalty earnPoints (atomic upsert), pos exchange/shift-close/returns-refund, marketplace commission bps math.
