---
"@porulle/plugin-channel-connector": patch
---

Two stores converging the same category or brand at once both link to it, and no reconcile reads as clean after dropping an item.

- Creating a category or brand that another writer created first now adopts that row instead of failing. Previously the conflict was thrown or returned, and either failed the whole reconcile ("Category with slug belt already exists") or left one product with no category and no brand link while the reconcile reported success.
- A taxonomy failure is now that item's failure, and `channel/reconcile`'s report carries `failures` (each item with its error), so a reconcile that dropped an item is never reported as a clean one.
- `channel/reconcile-sweep` enqueues only stores whose provider has a registered connector. A `manual` store no longer gets a reconcile that can only fail.
