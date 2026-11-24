---
"@porulle/core": minor
"@porulle/adapter-shopify": minor
"@porulle/plugin-channel-connector": minor
---

Webhook deliveries are minimized before they are queued, erasure matches exactly, and a bag's unavailable stores are named.

- `ChannelConnector.minimizeWebhookPayload` keeps only what decoding reads; Shopify implements it.
- Compliance requests match the orders Shopify names (and their email), else the email; never the union. Deferred redactions are kept per store.
- `refreshLineStock` answers `unavailableStores`, reports unmapped lines, drops a late answer and writes several levels with `setAbsoluteMany`.
- `channel/apply-webhook` parses its input.
