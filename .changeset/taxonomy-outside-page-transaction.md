---
"@porulle/core": patch
---

`catalog.importProducts` resolves the shared vocabulary (tags, categories, brands) in its own short transaction before the page transaction opens, not inside it.

A tag, category or brand the page created used to stay uncommitted until the whole page committed. Every other page naming it waited on that unique index for the entire page, whether it came from another store or from the same store's next page. On the sim a tag insert waited 36.6 s behind one 89 s page.

Now another store's page sharing a new tag completes while the first page's transaction is still open (measured on real Postgres: 5–6 ms, against more than 5 s blocked before).

Behaviour change: a page rejected under `errorPolicy: "reject-everything"` still rolls back every item, but the vocabulary it created can remain. Vocabulary is organization-wide and reusable.
