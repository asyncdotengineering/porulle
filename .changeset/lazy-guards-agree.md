---
"@porulle/core": patch
---

Let a granted permission win before a plugin route decides the caller's class.

0.24.0 gave the plugin-route guard the new `isUnauthenticatedActor` test while leaving its original ordering — auth first, then permission — in place. That ordering was correct for as long as the test was `!actor`, and wrong the moment the test began recognising an actor that exists but carries no identity: such a caller was refused `401` before anything read what it was allowed to do.

**An actor can hold a permission without holding an identity.** A storefront widget posting search signals carries only a publishable key, so it resolves to the anonymous actor the store resolver builds and is authorized by that actor's permissions. Under 0.24.0 that flow answered `401` where it had answered `201`.

The grant is now read first, which is the order `requirePerm` already used; the caller's class is decided only on a refusal, where it is the question actually being asked. Pinned by a test that fails with `expected 401 to be 200` when the grant check is disabled.
