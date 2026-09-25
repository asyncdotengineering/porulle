---
"@porulle/plugin-channel-connector": minor
"@porulle/adapter-shopify": minor
---

A Shopify `inventory_levels/update` webhook now sets the stock of the variant it concerns. The webhook names an inventory item, whose id differs from the variant id the channel map is keyed by, so every Shopify stock webhook used to find no mapping and be dropped. The Shopify adapter records each variant's `inventoryItemId` in its metadata on import, and the connector resolves the webhook's inventory item to that variant, falling back to the variant-id lookup for providers that send one.

Note: adding `inventoryItemId` changes the content of every Shopify-imported variant, so the first reconcile after upgrading re-converges each Shopify product once.
