---
"@porulle/plugin-channel-connector": patch
---

Fan out Shopify compliance redaction across every connected store that shares a `shop_domain`. `customers/redact` / `shop/redact` / `customers/data_request` now resolve all matching stores (via `getStoresByDomain`) and apply to each, so PII is erased on every copy rather than only the first match.
