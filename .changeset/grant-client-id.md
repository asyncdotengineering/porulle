---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

A grant records the app that issued it, and refusals are compared with the grant that was refused.

- `ShopifyCredentials.clientId` is written by every grant and kept on renewal.
- `ChannelConnector.acceptsAppWebhook` lets a connector say whether a verified delivery's signer is the store's own app; `decodeWebhookNeedsCredentials` lets a delivery decode after the credentials are gone (an uninstall, the redaction that follows it).
- A compliance delivery whose signed shop differs from its header is refused.
- A refused renewal marks a store `error` only while it still holds the refused credentials.
- `onAppWebhookUnclaimed`, `storeApp`; unexpected errors return a stable sentence without query parameters.
