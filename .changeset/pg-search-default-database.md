---
"@porulle/core": minor
"@porulle/adapter-pg-search": minor
---

Let `pgSearchAdapter` use the configured database instead of requiring a second connection.

`PgSearchAdapterOptions.query` was required, so every consumer hand-wired raw SQL execution — typically by opening a second pool against the database porulle was already connected to.

`SearchAdapter` gains an optional `init?(deps: { db })` hook, called by the search module when it wires the adapter, and `pgSearchAdapter()` now takes no required argument:

```ts
search: { adapter: pgSearchAdapter() }
```

A supplied `query` callback still takes precedence and is never overwritten by `init`, so pointing search at a separate database remains possible. Adapters that do not define `init` — including the meilisearch adapter — are unaffected.
