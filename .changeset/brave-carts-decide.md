---
"@porulle/core": minor
---

Price a cart line from the pricing step, and refuse the add when it has no answer.

`cart.addItem` wrote `unitPriceSnapshot: processed.unitPriceSnapshot ?? 1000` — a literal — whenever no `cart.beforeAddItem` hook supplied a price. Nothing in the response, the logs or the schema disclosed that the number was invented, so an integrator could only learn it by comparing a cart against a catalog. One did: a deployed cart reading 1000 against a catalog priced 14500–22800.

A new line is now priced by `services.pricing.resolve` — the same step `resolveCurrentPrices` uses in the checkout quote — so a cart and its order agree by construction rather than by an integrator remembering to install a hook. Modifiers apply, because they are part of that step and were never part of the literal.

When no price can be resolved, the add is refused with `Cannot resolve a unit price for <entityId> (<currency>). Configure a price for it, or supply unitPriceSnapshot from a cart.beforeAddItem hook.` A value the system cannot determine is refused rather than substituted; a second literal would be the same defect wearing a different number.

A `cart.beforeAddItem` hook that supplies `unitPriceSnapshot` still wins, so bespoke pricing keeps its seam, and merging into an existing line still leaves that line's snapshot alone.

**This changes behaviour for callers who never configured prices**, which is why it is a minor rather than a patch: an add that used to succeed at 1000 now either carries the real price or refuses. Nineteen fixtures in this repository's own suite were adding unpriced entities and passing on the literal; each now configures a price. If you rely on a cart line for an entity with no price row, supply `unitPriceSnapshot` from a hook, or set a base price — including zero, which is a decision, where 1000 was not.

`test/cart-add-item-pricing.test.ts` pins all three directions: a priced entity with no hook carries its price, an unpriced one is refused with the price named, and a hook still overrides.
