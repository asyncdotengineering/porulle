---
"@porulle/adapter-shopify": patch
---

Fix Shopify webhook verification to use the app client secret. Shopify signs every webhook for an app with the app's client/API secret key, not a per-store secret — `verifyWebhook` now verifies against the configured `clientSecret` instead of `store.webhookSecret` (which never matched real Shopify deliveries), and requires `clientSecret` to be configured. WooCommerce keeps its per-webhook secret.
