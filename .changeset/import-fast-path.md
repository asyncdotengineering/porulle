---
"@porulle/core": minor
"@porulle/plugin-channel-connector": minor
---

Add the catalog import fast path: a page of new products lands in one transaction.

`catalog.importProducts(page, { sourceStoreId, errorPolicy }, actor)` is the importer
path the editor path never was. Measured on the PGlite query log, one 12-variant
product cost 564 statements through `create` + `createVariant` + `setAttributes` +
taxonomy links, because every call re-read the entity, recorded a revision and wrote
one row per statement. The fast path reads the page's taken slugs and shared
vocabulary once (creating what is missing with `ON CONFLICT DO NOTHING`, so two
consumers landing pages that share a brand both succeed), writes each item multi-row
inside its own savepoint, records one revision per item and fires one
`catalog.afterImport` hook per page — which the audit module records as one row.
Twenty such products cost 262 statements, 13.1 per item. `errorPolicy` is Saleor's:
`reject-failed-rows` (the default) isolates a bad item behind its savepoint and
reports it by ref and code; `reject-everything` rolls the page back. It creates and
never updates; a caller that finds an item already present routes it through the
editor path.

The channel connector gains the page-shaped half: `fetchCatalogPage` returns one
connector page and writes nothing; `convergeCatalogPage` sends never-mapped items
down the fast path, skips mapped-and-unchanged items for free, and routes changed or
orphaned items through the existing converge. Only each new item's hero image is
fetched, streamed under `HERO_IMAGE_BYTE_CAP` (1 MiB — a larger one is reported, not
stored, and the product still lands), and linked at entity level as `primary` plus to
the variants it shows; `selectImportImages` returns that hero and the first photo of
each other variant, which come back as `deferredMedia` for the host to land later.

`@porulle/core/testing` now exports `createPGliteTestAdapter`, whose query log is the
only statement counter that sees what core issues.
