---
"@porulle/core": minor
---

Make `actor` a required argument on `catalog.list`, `catalog.getById`, and `catalog.getBySlug`.

**Breaking for consumers** calling these methods directly: `actor` is now required (pass `null` to mean anonymous deliberately), and `options` must be passed explicitly as `undefined` when absent.

Previously, omitting `actor` silently treated the read as anonymous storefront-filtered. Callers must now pass the actor they are acting for, or `null` when anonymous access is intentional.
