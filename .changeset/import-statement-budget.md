---
"@porulle/plugin-channel-connector": patch
---

Stop the catalog import re-reading and re-writing what has not changed.

Measured on a deployed Worker: ~379 I/O operations per product with at most one in
flight at a time outside media. Three sources, all removable without changing what
the import produces:

- `applyTaxonomy` read the organization's whole categories, brands and tags tables
  once per PRODUCT. They are now read once per converge run and shared.
- `upsertOptionAxes` read back every option type and option value it had just
  created, and issued an UPDATE for each one whether or not `displayName` or
  `sortOrder` had moved. The row is constructed from what was sent, and the update
  is conditional.
- `upsertVariants` read `variant_option_values` once per variant, and wrote the
  variant's `syncHash` on every pass regardless of whether the variant changed.
  The read is one query for the whole entity; the write is conditional.

A repeat sync of an unchanged product drops from 41 to 23 service-issued statements
on the new `import-statement-budget` test's fixture, a ratio of 0.80 to 0.52.
