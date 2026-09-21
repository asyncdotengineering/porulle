---
"@porulle/plugin-channel-connector": patch
---

Forward `entityIds` and `failures` from a bounded catalog batch into the step's return value.

`convergeCatalogItems` has reported the entity ids a batch committed since 0.48.0, and the bounded
`importCatalog` overload declares them — but `channel/import-catalog`'s own `runBatch` dropped both
fields on the way out, so nothing downstream of the durable step could see them. `walkBatches` keeps
only `last`, which makes the resolved value of each `step.do` the only per-batch seam a host
application has: a host that wants to emit one message per converged page, instead of one enqueue
per product, had nowhere to read the page from.

`entityIds` is forwarded unconditionally, matching the service's own return. Omitting it when empty
would make "this batch committed nothing" and "this build does not report entities" the same
`undefined` at the seam, and a caller that collapses those enqueues nothing and reports success.
