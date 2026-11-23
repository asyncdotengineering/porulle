---
"@porulle/adapter-shopify": minor
---

Token exchange for an app Shopify installs and loads in the admin.

- `verifyShopifyIdToken({ token, clientId, clientSecret, now })` checks an ID token as Shopify documents: HS256 over `header.payload` under the client secret in constant time, `exp` in the future, `nbf` in the past (10 s of clock skew allowed), `aud` equal to the client id, and `iss` and `dest` on the same `*.myshopify.com` host. It returns the shop and the staff member, or `SHOPIFY_ID_TOKEN_INVALID`.
- `exchangeIdToken({ fetchImpl, origin, clientId, clientSecret, idToken, requiredScopes, now })` trades the ID token for an expiring offline token. Shopify's 400 for a stale or invalid ID token is `SHOPIFY_ID_TOKEN_INVALID` (a fresh token fixes it), not a refusal of the app. Scopes the store did not grant are refused with `SHOPIFY_SCOPES_NOT_GRANTED`, as the code grant does.
- `validShopDomain` is exported, for a host that checks a `shop` parameter before trusting it.
