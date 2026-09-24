---
"@porulle/adapter-shopify": minor
---

`fetchInventory` now reports stock for EVERY variant, keyed by variant id.

It asked `inventory_levels.json?limit=250` once and never followed `Link`, so a 3,000-product store was levelled for one 250-row page. Against real Shopify it was worse: that endpoint requires `inventory_item_ids` or `location_ids`, takes at most 50 ids, and keys levels by inventory item id (not the variant id the connector matches), so a real store levelled nothing.

- **Full sync, or more than 25 ids:** one walk of `products.json?fields=id,variants`, every page (ceil(products / 250) requests), reading each variant's `inventory_quantity`.
- **Up to 25 ids (the order-time stock check):** one `variants/{id}.json` each. A variant Shopify no longer has is omitted, so the caller refuses that line.
- Negative stock reads as 0. `inventory_quantity` sums all of a shop's locations, so a store with a non-selling location overstates sellable stock.
