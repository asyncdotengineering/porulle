---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

A credential the caller presents (`Authorization` or `x-api-key`) that fails verification is now refused with 401 and a `WWW-Authenticate` challenge instead of being served as an anonymous guest; a rate-limited API key answers 429. Absent credentials, and a stale session cookie on its own, stay anonymous. Clients that relied on an expired token silently falling back to a guest must drop the credential or re-authenticate.

The channel connector normalises in-product duplicate SKUs at its item intake (`withDistinctVariantSkus`, exported): per item the variant with the smallest externalId (string order) keeps a repeated SKU and the others become `${sku}-${externalId}`. Converge, the sync hash and reconcile now read the same variants, so a suffixed product no longer records a `variants.sku` conflict on every reconcile.
