---
"@porulle/core": patch
---

`catalog.list` accepts `filter.sourceStoreIds` and narrows the result to entities imported by those connected stores, in the repository query so pagination and totals stay exact; an empty list matches nothing. Lets an app confine a shared-organization catalog list to the stores an actor owns.
