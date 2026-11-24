---
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

One identity per connection, so work queued for one connection never acts on the next.

- Every connect or reconnect writes a fresh random `grantId` into the stored credentials (any provider); a credential renewal keeps it. A delivery to the provider-wide address carries its `signer` and the store's `grantId` into the `channel/apply-webhook` job as `origin`. When the job runs, the connector's `acceptsAppWebhook` is asked again with that signer, and `app/uninstalled` and the disconnecting half of `shop/redact` apply only while the store's current `grantId` equals the carried one; otherwise the job succeeds with `{ processed: false, reason: "superseded" }`. Contact redaction in `shop/redact` and `customers/redact` still runs. `disconnectStoreSystem(orgId, id, options)` now takes `{ redactDomain?, ifGrant? }` and answers `SUPERSEDED` when the connection it was asked to end is no longer the store's.
- The `onShopRedacted` and `onAppWebhookUnclaimed` options are replaced by one `onShopEnded({ db, provider, shopDomain, topic, signer })`, called for a current `app/uninstalled` or `shop/redact` whether or not a store accepted it, so a host removes what the signing app issued and nothing else.
- Receipt of an app-level delivery: everything between recording the delivery id and queueing the job is one unit; any failure forgets the id and answers a stable 503 without the error's text.
- `connectStore` and `completeConnect` take the store profile the caller already read and hand it to `afterStoreConnected`. A failure after the credentials are committed is reported as `AFTER_CONNECT_FAILED` with a plain sentence (a refusal the host threw on purpose keeps its own words) and leaves the store in `error` saying to connect again; no query text, parameters or provider text is returned or logged.
- A successful renewal that lands for the same grant clears an `error` that a refusal of that grant had set (never any other `error`), and a renewal that lost to a disconnect answers `STORE_DISCONNECTED` and is not used.
- A repeated `customers/redact` or `shop/redact` keeps the earliest deferred `requestedAt` for a store. An order whose contact was erased for a store is never rebuilt for it (`CONTACT_ERASED`), and a manual store's slice keeps shared contact only until the order is final, in both erasure predicates.
- `refreshLineStock` re-reads the store's status once after a failed read, so a store that stopped taking orders during the read is reported as unavailable.
- Shopify: an `app/uninstalled` body that names a shop other than the signed header's is refused.
