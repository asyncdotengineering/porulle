---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
"@porulle/adapter-shopify": minor
"@porulle/adapter-woocommerce": minor
---

Add generic one-click store onboarding: Shopify OAuth and WooCommerce `/wc-auth` endpoint flows via new engine-plugin routes (`/api/channels/oauth/{provider}/start` + `/callback`), signed single-use callback state, and connector `buildAuthUrl`/`completeAuth` methods — alongside the existing credential-paste path. Includes customer-PII redaction groundwork for Shopify compliance webhooks (app-level delivery ingress pending).
