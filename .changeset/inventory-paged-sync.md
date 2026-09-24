---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
"@porulle/adapter-shopify": minor
---

A store's inventory sync takes one catalogue page per step and writes it set-based.

- **Core:** new `inventory.setAbsoluteMany(rows, actor, ctx?, { reason })`. It keeps `setAbsolute`'s invariants (permission, default warehouse, org, no-op on unchanged, a clamp at 0, the `version` bump, one movement per change) in a constant number of statements per call: 10 per page in the connector's sync, for 10 levels or 100. It announces each page ONCE through the new `inventory.afterAdjustMany` hook, with the changed levels grouped by product. It does not fire `inventory.afterAdjust` per level.
  - Core's audit (new `AuditService.recordMany`, one insert) and outbound webhooks (still one `inventory.update` event per changed level) both handle the bulk hook.
  - **Breaking for subscribers:** a plugin or `config.inventory.hooks` that subscribes to `inventory.afterAdjust` must also subscribe to `inventory.afterAdjustMany`, or the kernel refuses to boot, naming the subscriber. Otherwise that subscriber would silently miss every bulk sync.
- **Connector:** new optional `ChannelConnector.fetchInventoryPage(store, cursor)`. With it, `syncInventory` makes one page fetch, one mapping read and one `setAbsoluteMany` per step, and stores the next cursor on the store. The old path re-read the store's whole inventory and every map row on every 20-level step, and on a 27k-variant store it hit a Workflow ceiling after 1,340 levels.
- **Shopify adapter:** implements `fetchInventoryPage`, one `products.json` page per call. `fetchInventory` walks it.
- **Known limit:** connectors without `fetchInventoryPage` (WooCommerce, manual) keep the old path.
