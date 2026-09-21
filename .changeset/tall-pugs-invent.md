---
"@porulle/plugin-channel-connector": minor
---

Report the entity ids a catalog batch committed

`convergeCatalogItems` reported how much it imported and what failed, but not *which* entities it committed. A caller that wanted to act on the page it had just converged had no way to name it, so the only shape available was one enqueue per product — which is what put 1,303 nested Workflow instance creations behind a single sweep.

`CatalogConvergenceStats` and the bounded import's outcome now carry `entityIds`: committed only, in input order, failures excluded, de-duplicated. `BatchOutcome` carries it alongside `failures`, and both stay JSON because they cross a durable step boundary.

`entityIds` is returned **unconditionally**, while every sibling field on that outcome is conditional-on-non-empty. The asymmetry is deliberate: a caller must be able to tell "this batch committed nothing" from "this build does not report entities". Collapsing those two makes a caller enqueue nothing and report success.
