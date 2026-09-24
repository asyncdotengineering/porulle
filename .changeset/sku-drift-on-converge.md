---
"@porulle/plugin-channel-connector": minor
---

Converge applies upstream SKU and barcode changes to variants a store already maps. Until now they were dropped silently, and the local variant kept its old SKU for good.

- A written SKU or barcode bumps `variants.updated_at` and counts toward `converged`. A platform-owned or held `variants.sku` / `variants.barcode` stays local.
- **Swaps:** SKU is unique per source store. The changes for a whole converge batch are applied in one transaction that first releases every changing SKU, then sets the new values. Variants exchanging SKUs, within one product or across products in the same batch, therefore land together.
- **Clashes are loud but not fatal.** An upstream SKU another variant of the store still holds keeps the local SKU. Converge records an open `variants.sku` conflict naming the holding variant and still converges every other field of the product. This covers a genuine duplicate, and a swap split across two import pages.
- The next reconcile sees the whole catalogue in one batch. It lands a split swap and closes its conflicts automatically.
