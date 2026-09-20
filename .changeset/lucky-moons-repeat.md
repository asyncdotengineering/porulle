---
"@porulle/plugin-channel-connector": minor
---

Isolate converge failures to the item that caused them.

`convergeCatalogItems` returned `PluginErr` on the first item that failed. In `importCatalog` that return happens BEFORE the `connected_stores.catalogCursor` write, while every item already converged in the batch stays committed. The retry re-fetched the same page, re-converged the same prefix and failed on the same item again, so one malformed product halted the rest of a merchant's catalog at whatever position it sat in, permanently — no retry advanced past it.

The four in-loop aborts and any unforeseen throw now record the item and continue. `consumed` was already incremented before the body, so a failed item still advances the offset and the walk moves on. Saleor calls this choice REJECT_FAILED_ROWS as against REJECT_EVERYTHING; this is the former.

`CatalogConvergenceStats` gains a required `failures: CatalogConvergenceFailure[]`, and `importCatalog` returns `failures` on both paths when non-empty. Surfacing it is the point: recording a failure without returning it would turn a loud halt into a silent drop, which is worse than the behaviour it replaces. `CatalogConvergenceFailure { externalId, error }` is exported from the package entry and keys on the merchant's id, because a failed create leaves no entity to name.

A dry run reports `failures: []`; it converges nothing, so it can fail nothing.
