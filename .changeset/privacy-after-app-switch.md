---
"@porulle/plugin-channel-connector": minor
---

A privacy request still erases past orders after the shop moves to another app, a shop's disconnect and its host cleanup commit together, and an uninstall applied late no longer removes what is newer than it.

- `handleWebhook` applies the compliance requests (`customers/redact`, `shop/redact`, `customers/data_request`) of a delivery the connector no longer accepts, when the connector decodes it from its own body (`decodeWebhookNeedsCredentials` is `false`), so deciding it makes no call to the shop. Disconnecting the store, redacting its domain and `onShopEnded` stay with the connection the delivery was accepted for. Every other delivery is still answered `not_accepted`.
- `disconnectStoreSystem` takes `alongside`, which runs in the disconnect's own transaction. `connection.revoked` and `shop/redact` run `onShopEnded` there, so a failed cleanup undoes the disconnect and the retry does both. The provider's `unregisterWebhooks` call stays outside the transaction.
- `AppDeliveryOrigin` carries `receivedAt`, the delivery's arrival time on the database's clock, through the queued job (an ISO string; optional for jobs queued before). `OnShopEnded` receives it, so a host can remove only what was written at or before it.
- `redactOrdersContact` runs in one transaction that locks the order rows and writes the store's erased marker before it clears exports and returns, and `exportOrder` writes contact under the same order lock, so an export cannot put contact back during an erasure. The lock is not held across the store call.
