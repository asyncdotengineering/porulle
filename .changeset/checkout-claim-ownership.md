---
"@porulle/core": patch
---

Give a cart's checkout claim an owner, so a losing checkout can no longer release the winner's claim.

The `active → checking_out` compare-and-swap was already correct, but every pipeline failure called `releaseCheckoutClaim(cartId)`, which reset `checking_out → active` with no notion of who held the claim. A checkout that lost the claim therefore unwound the in-flight winner's claim on its way out, and a third attempt walked into the gap: one cart, two orders, two payment intents, each authorising the full total.

`carts` gains a nullable `checkout_claim_token` column holding the checkout id of the attempt that won the claim. Releasing is now conditional on presenting that token, so an attempt that never held the claim cannot reopen the cart, while a shopper whose own checkout fails still gets their cart back and can retry.

**Migration:** the new column is nullable and set by `pushSchema`; no data migration is required. Carts sitting in `checking_out` at deploy time have no token and will not be released by a failing checkout — abandon or reset them if any are stuck.
