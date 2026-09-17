---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
"@porulle/adapter-shopify": minor
---

Breaking: the channel connector pushes an order to its merchant when payment lands, not when the order row is created

**The default changed. If you use `@porulle/plugin-channel-connector` and your orders start in `pending_payment`, they are no longer pushed at creation** — they are pushed when they leave that state for anything but `cancelled`. This is a behaviour change, not only a new option: a consumer reading "added `pushOrderOn`" and nothing else would not learn that their push moved.

Until now `buildHooks` registered an `orders.afterCreate` hook that enqueued `channel/push-order` the moment the order row existed, with no reference to payment. For any consumer with a payment step that pushed an unpaid order to a real merchant, who then picks, packs and ships it.

`ChannelConnectorPluginOptions.pushOrderOn` selects the trigger:

- `"payment"` (the new default) — an order created in `pending_payment` is not pushed; it is pushed on `orders.afterStatusChange` when it leaves `pending_payment` for anything but `cancelled`. An order created in `pending` is still pushed on creation, so a store with no payment step is unaffected.
- `"create"` — the previous behaviour, for consumers who want it. Set this to keep today's timing.
- `false` — no automatic push at all; enqueue `channel/push-order` yourself.

The predicate is the *transition* (`fromStatus === "pending_payment"`), not "the new status looks paid". Core commits a status with a compare-and-swap, so exactly one caller wins a given transition and the push fires exactly once by construction. Keying on the new status alone would re-push on every later move, because `exportOrder` short-circuits only on an already-`confirmed` export and pushes one still `exported` again.

**`orders.afterStatusChange` hooks now receive the transition in `data`.** It was always `null`, because `runAfterHooks` was called with `null` as its original data while core had already built the `{ orderId, fromStatus, newStatus, reason? }` input for the *before* hooks and then discarded it. A hook that needed to know which transition occurred could not find out; the order itself carries only the status it now has.

`AfterHook` takes an optional second type parameter for this — `AfterHook<TResult, TData = TResult>` — so `data` and `result` may differ in shape where the committed entity is not the input. The default keeps every existing single-argument use identical, and `runAfterHooks` gained the matching parameter.

**Known and deliberately unchanged:** core's own `sendOrderStatusEmail` reads `result.newStatus` and `result.previousStatus`, which the hydrated order does not carry, so it has never sent an email and still does not. Switching a dormant customer-facing email path on is a separate decision from moving the seam, and it is not made here.

Also: `@porulle/adapter-shopify` now carries variant weight through `importCatalog`.

Shopify's REST variant returns `grams`, plus `weight` with a `weight_unit`, on every variant. The adapter's internal response type declared none of them, so `importCatalog` discarded the weight and every imported product arrived weightless. Variants now map to `metadata.weightGrams`, the key `resolveWeightGrams` reads when it prices shipping.

`grams` wins when present and positive; otherwise `weight` is converted from `g`, `kg`, `oz` or `lb`. An unrecognised `weight_unit` is refused rather than assumed to be grams — reading `"lbs"` as grams under-prices a parcel by a factor of 453. The key is **omitted** when no weight is known, never written as `0`, because `0` is indistinguishable from a genuinely weightless item. This half is additive: a consumer that ignores `variant.metadata` is unaffected.
