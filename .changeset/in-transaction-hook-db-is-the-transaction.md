---
"@porulle/core": minor
---

A hook marked `inTransaction: true` is handed a context whose `db` IS the transaction.

`inTransaction` bought ordering, not atomicity: the hook ran inline before the commit, but
`context.db` was still the plugin db handle, and on a two-connection driver — Neon over HTTP, where
every plain query is its own request — a write on that handle is not part of the transaction and
survives its rollback. Measured on a deployed Worker: an aborted write left `entity_exists = 0` and
`pending_for_aborted = 1`, a row that rolled back announcing itself in the outbox whose whole purpose
is committing with the write it records.

Plugins no longer have to remember `ctx.tx ?? ctx.db`. A marked hook that writes through the obvious
`context.db` now lands inside the transaction. A marked hook fired for a write performed outside any
transaction still receives the outside connection, because that is the only connection there is.
Unmarked hooks are unchanged: after the commit, with `tx: null`, on the outside connection.
