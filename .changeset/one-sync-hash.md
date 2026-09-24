---
"@porulle/plugin-channel-connector": minor
---

The fast path and reconcile now compute ONE sync hash over the item's content, so a product the fast path imported no longer looks changed to the next reconcile.

- `channelSyncHash(value)` (exported) hashes canonical JSON: keys sorted recursively, `undefined` dropped, array order kept. The hash was `sha256(JSON.stringify(item))`, which is sensitive to key order. A host that rebuilds landed items in its own key order, as a page consumer re-reading R2 does, therefore produced a different hash for the same product, and every reconcile re-converged every freshly imported product.
- **Migration:** maps written before this release carry the old hash. Each looks changed exactly once. That converge is content-identical, so it writes no entity or variant, fires no `catalog.afterUpdate`, and only brings the map's hash current. After that it's a plain no-op.
- The link-provenance claim runs no query for a batch whose items list no category, brand or tag. Otherwise it costs one select per converge call, never one per product. This restores the bounded-import cost row that 0.56.0 had pushed past its allowance.
