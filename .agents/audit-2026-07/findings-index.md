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

## ROUND 3 (adversarial) — deep money-math cross-check
- CRITICAL: percentage-modifier rounding on UNIT price then ×quantity (pricing/service.ts:172-184 → checkout.ts:237-238). 50%-off on unitPrice=1, qty=1M → resolvedTotal=0 (should be 500000). A % discount silently becomes 100%-off/free on bulk low-unit-price SKUs. Fix: round discount on extended line total, not unit price.
- HIGH: promotion stacking cap clamps aggregate totalDiscount but NOT individual applied[].discountAmount → persisted appliedPromotions ledger sums > actual discount (e.g. two 70% promos on 10000 → ledger says 14000 saved on 10000 order). recordUsage records unclamped. sum(parts)≠whole, externally visible. Fix: rescale applied[] proportionally (calculateByClasses drift pattern).
- MED-HIGH: buy_x_get_y = freeUnits × GLOBAL-min-unit-price, ignoring cheapest item's own qty → understates "cheapest units free" ~20x (500-unit A qty1 + 10000-unit B qty99 → got 25000, expected ~490500). Fix: allocate against flattened price-sorted actual units.
- LOW-MED: multi runtime tax rates — amountToCollect sums per-rate rounded amounts but reported `rate`=totalBps/10000 (unrounded) → taxableAmount×rate ≠ amountToCollect. Fix: rate = amountToCollect/taxableAmount (as calculateByClasses does).
- VERDICT: money math NOT provably consistent. calculateByClasses discount proration is the ONE exact template the others should match.

## ROUND 3 (adversarial) — schema, migrations & data integrity
- HIGH (systemic): 9 plugin schemas have organizationId as bare text, NOT FK-constrained to organization (wishlist is the lone correct one). Org delete → plugin rows (BOMs, UOM, appointments, notification templates, channel mappings, compensation-failure ledger) silently orphaned; recycled org id inherits dead rows.
- HIGH: appointments booking graph — zero FK integrity + NO double-booking constraint (only a plain index; needs EXCLUDE USING gist on (providerId, tsrange)). Concurrent overlapping bookings both succeed → provider double-booked. bookingPayments.bookingId unique but not FK → orphan captured-money rows.
- HIGH: taxClasses.isDefault has no partial-unique index + clear-old-default is non-atomic (check-then-act) → concurrent create → TWO default tax classes → resolveCatalogTaxClasses picks nondeterministically → checkout tax rate varies per request. Fix: partial unique index ON tax_classes(org) WHERE is_default.
- MED: orders/cart customerId, promotionUsages, apikey.referenceId bare (no FK) → delete customer/user leaves dangling refs; operator API key outlives its user (credential with no owner).
- MED: customerReviews no FK + no unique(customerId,orderId,entityId) → review-bombing, isVerified not linked to purchase.
- MED: member no unique(organizationId,userId) → duplicate membership → ambiguous RBAC. webhookDeliveries.endpointId no onDelete → org offboarding hard-fails. processedWebhookEvents.eventId GLOBAL unique (not per provider/org) → cross-provider/tenant event-id collision silently swallows a legit webhook. production BOM subBomId self-ref no cycle guard.
- VERDICT: core spine FK-disciplined; plugins systematically drop the pattern. Enforcement gap, cheap to close (mostly one-line .references() + partial unique indexes).

## ROUND 3 (adversarial) — remaining plugins + adapters
- CRITICAL: adapter-stripe refundPayment blind-casts free-form reason → Stripe 400 → returns Err, but ALL 3 callers (checkout-completion:192, orders/service:855,1142) discard the Result (bare await) → ledger records refunds Stripe NEVER issued; compensation auto-refund silently no-ops. Customer money loss. Fix: map reason to enum + check Result.
- CRITICAL: adapter-pglite manual BEGIN/COMMIT/ROLLBACK via pg.exec on the SINGLE shared instance → concurrent transaction() calls interleave (B's BEGIN no-ops in A's tx; first COMMIT flushes both). Defeats atomicity on the zero-infra default backend. Fix: use PGlite native .transaction() or serialize via async mutex.
- CRITICAL: appointments getById/changeStatus filter bare id (no org) → cross-tenant; /cancel + /reschedule only .auth() (any user cancels ANY booking → refund); double-book (FOR UPDATE over empty range locks nothing, no EXCLUDE constraint); payment intent created BEFORE conflict check; racing cancels → double refund (no idempotency).
- CRITICAL: plugin-reviews isVerified from client-supplied orderId != null, no orders service wired → fake "verified purchase" badge for unbought products.
- HIGH: meilisearch toFilter string-interpolates raw type/category/brand/status (filter injection) + uncapped limit (bulk exfil of the unauth global index) + pg-search unbounded facet scan (DoS).
- HIGH: stripe no idempotencyKey on create/capture/refund (retry → double charge). adapter-neon fresh Pool per transaction() → connection exhaustion + swallowed teardown. 
- HIGH: email adapters — order-invoice template unmapped → dumps JSON.stringify(data) unescaped into <pre> (broken + HTML-injection into arbitrary-recipient email); password-reset/verify read d.url but caller sends resetUrl/verifyUrl → every reset/verify link is href="#" (account recovery dead).
- HIGH: storage upload contentType stored/served verbatim (client sets image/svg+xml or text/html → stored XSS) + no size limit (memory DoS). channel-connector convergeCatalogItems overwrites local slug/metadata (lost update); channelOrderExports no unique(storeId,orderId) → double push; local refund without cancelling remote.
- HIGH: production complete() paper-only (component stock not consumed, finished goods not stocked) + cycle-less BOM recursion (stack overflow). uom /convert accepts float but math fixed-point ×10000 (10000x error); uom FK binds not org-scoped.
- MED: notifications no send idempotency (retry → duplicate SMS/push); print job never advances past queued.
- CLEAN: plugin-wishlist (org+unique+scoped); adapter-postgres; production org-isolation/state-machine.
- Agent recommends BLOCKING release on the 2 adapter CRITICALs (stripe fail-open, pglite tx) + appointments cluster.

## ROUND 3 (adversarial) — kernel / runtime / migrations
- CRITICAL (EMPIRICALLY REPRODUCED): scoped-db proxy drops org isolation on join+where. .from() eagerly wraps with orgEq, but .innerJoin()/.leftJoin() returns the UNWRAPPED builder, then .where(callerCond) REPLACES orgEq (Drizzle where semantics) → NO organization_id predicate. The idiomatic from→join→where pattern plugins are told to use = silent full cross-tenant read. Confirmed in plugin-pos shift-service (saved only by a redundant manual filter/ownership check). Fix: inject org predicate at statement-build time for all scoped tables (FROM+JOIN), or ban joins through the proxy + fail-closed assertion.
- HIGH: job reaper has NO lease/heartbeat — threshold = now - processingStartedAt only. A job legitimately running > threshold (default 300s) gets flipped processing→pending while still executing → deterministic double-execution (root cause of R2's WooCommerce symptom; affects ALL tasks incl. webhook delivery). Fix: heartbeat column + reap on heartbeat staleness.
- HIGH: hook timeout (withTimeout) races via Promise.race but NEVER cancels the hook — zombie hook keeps running with live db/tx/services after the op is treated as failed → late writes / unhandled rejection tripping the process-crash handler. No AbortSignal on Before/AfterHook. Fix: thread AbortSignal + abort on timeout.
- MED-HIGH: job runner concurrencyKey exclusivity race — processingKeys snapshot read BEFORE the FOR UPDATE SKIP LOCKED claim (READ COMMITTED) → two parallel runners each claim a DIFFERENT row with the same concurrencyKey → isExclusiveTask violated under the horizontally-scaled polling the module advertises. Fix: pg advisory lock per key.
- MED: config.middleware mounted BEFORE authMiddleware → custom middleware sees c.get("actor")===undefined (not the resolved value) → actor-gating authz silently no-ops. Fix: mount after auth or assert/document.
- VERDICT: compensation chain sound (traced — steps manage own tx, don't share ctx.tx). Real risk: two "safety" primitives (scoped-db proxy, job exclusivity/reap) silently fail under idiomatic usage.
