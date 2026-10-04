---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

Cancel channel orders in both directions. Connectors gain an optional `cancelOrder` (Shopify: `orderCancel`, restocking, refunding nothing at the store, notifying no one), and a store refusal answers `CHANNEL_CANCEL_REFUSED`. The channel connector cancels at the store before the platform cancels, so a store that has shipped blocks the cancel; a store's `orders/cancelled` cancels the platform order without cancelling back; an order cancelled before its push ran is never pushed.
