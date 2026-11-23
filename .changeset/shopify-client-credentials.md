---
"@porulle/adapter-shopify": minor
---

Connect a store through the merchant's own Shopify app with the client credentials grant.

- `mintClientCredentials({ fetchImpl, origin, clientId, clientSecret, now })` mints a token for an app in the same Shopify organization as the store. Credentials it returns carry `grant: "client_credentials"`.
- `liveCredentials` (through `refreshIfExpiring`) renews such a token by minting again before its 24-hour expiry, since the grant has no refresh token.
- A token-endpoint refusal now names its cause: `SHOPIFY_SHOP_NOT_PERMITTED` (the app and the store are in different organizations) and `SHOPIFY_APP_NOT_INSTALLED`; anything else stays `SHOPIFY_REAUTHORIZATION_REQUIRED`.
- `subscribeShopifyWebhooks({ origin, accessToken, uri })` subscribes the app to every `SHOPIFY_WEBHOOK_TOPICS` topic with `webhookSubscriptionCreate`, creating only the missing ones, for an app whose configuration does not carry our subscriptions. Compliance topics cannot be subscribed this way.
- `missingScopes` is exported.
