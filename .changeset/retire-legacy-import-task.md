---
"@porulle/plugin-channel-connector": minor
---

**Breaking:** connecting a store no longer starts an import, and the legacy `channel/import-catalog` task is removed.

- `connectStore` (the `POST /api/channels/stores` route and the OAuth callback) used to enqueue `channel/import-catalog`. That was a sequential 20-products-per-invocation walk that then chained `channel/sync-inventory`, and it ran beside any host's own import. Connect now registers webhooks and returns the store; the host starts the import from its operator route.
- Removed: the `channel/import-catalog` task and the `CHANNEL_IMPORT_MAX_ITEMS_PER_INVOCATION` export. `ChannelConnectorService.importCatalog`, the library call, is unchanged.
- **Migration for hosts that relied on connect to import:** enqueue your own import after connect (and level inventory after it, e.g. `channel/sync-inventory`). Any code that enqueued `channel/import-catalog` must move to the host's import path; a job with that slug now fails as an unknown task.
