---
"@porulle/plugin-channel-connector": minor
---

An import sweep now levels inventory for the store it just finished importing.

`channel/import-catalog` chains itself while the catalog is not exhausted and, when it is,
returned — and nothing after it wrote `inventory_levels`. The only writers are `reconcile` and
`syncInventory`, and `reconcile` was reachable only through the hourly `channel/reconcile-sweep`
cron. A deployment that removes its crons therefore loses a data-plane write silently: every
product imported afterwards arrives with no inventory row, rolls up as out of stock, and is
published that way, with every suite still green.

Measured on the deployment that hit it: 104 entities, 1303 variants, 273 inventory rows, and only
25 of 104 entities carrying any inventory row at all — all-or-nothing per product, because the 25
are what the sweep wrote before it stopped running.

The exhausted branch now enqueues `channel/sync-inventory` for the same store, inside the same
continuation chain, so "import this store" remains one operator action and leaves a catalog someone
can buy from. A batch that is still mid-catalog does not reach for inventory; levels are set once,
after the catalog is whole.

Worth naming because it is the reusable lesson rather than the fix: the chain was rewritten in
#110 ("Finish a catalog in one import sweep instead of thirty products of it") *after* the sweep
that carried inventory was already dead. A chain gets rewritten and the thing that used to run
beside it is in nobody's head.
