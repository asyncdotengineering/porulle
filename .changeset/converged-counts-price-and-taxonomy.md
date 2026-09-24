---
"@porulle/plugin-channel-connector": patch
---

`channel/reconcile` counts a product as `converged` when an upstream change to only its price, tags, categories or brand is written. 0.50.0 counted `converged` from what was written, but price and taxonomy writes never raised a change flag, so those changes reported `converged: 0`.

- Converge now reads a product's base prices once and writes only those that differ. An unchanged price no longer re-writes its row or fires `pricing.afterCreate` on every sync.
- Category and brand links that already exist are not re-written; a link that is added counts as a change.
