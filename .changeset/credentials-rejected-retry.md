---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

Breaking: recover from a credential the provider retires early; refuse an owned shop before OAuth; level stock on a first reconcile.

- `@porulle/core` exports `CHANNEL_CREDENTIALS_REJECTED`, and `liveCredentials(store, { force })` may be asked to refresh regardless of the stated expiry.
- `@porulle/adapter-shopify` answers a 401/403 from the Admin API with `CHANNEL_CREDENTIALS_REJECTED` (was `SHOPIFY_UNAUTHORIZED`) and refreshes on `force`.
- `@porulle/plugin-channel-connector` retries a call rejected that way ONCE on credentials refreshed by force; a second rejection is the answer, and a refused refresh marks the store for reconnection. `ConnectClaims` receives the canonical `storeDomain`, and OAuth start resolves claims AFTER normalising the shop and BEFORE redirecting — a provider such as Shopify retires a shop's other grants as soon as a new one is issued, so a refusal must happen before the merchant reaches the consent screen.
- Fix: `reconcile` levelled stock against the mappings it read before converging, so a reconcile that imported products for the first time left them with no inventory level. It now levels against the mappings after convergence.
- Fix: the editor convergence path (every reconcile) created and updated variants without their `metadata`, so a reconciled variant lost the provider facts the import fast path keeps — Shopify's inventory item id (what a stock webhook resolves its variant by) and the weight shipping prices by. Variant metadata now merges per key on every path; an unchanged variant writes nothing. An unchanged reconcile keeps its statement budget: mappings are re-read for stock levelling only when convergence wrote something.
