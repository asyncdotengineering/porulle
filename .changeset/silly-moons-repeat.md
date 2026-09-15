---
"@porulle/adapter-neon": minor
---

Add `withPooledTransactions`, so one invocation's transactions share one Hyperdrive client instead of opening one each.

`transaction()` opens a fresh Postgres.js client per call and ends it in `finally`. Measured on a deployed Cloudflare Worker on 2026-09-15, one import of 100 products opened **63,355** of them, and a probe from inside that same Worker priced a client at 4 ms on the medians and 7.7 ms on the means against a reused one, 88 ms on the first — on the order of 250 to 500 seconds inside a 985-second import.

Wrapping a unit of work in `withPooledTransactions(fn)` gives every transaction inside it one shared client, closed when `fn` settles on either the success or the failure path. Nested calls join the enclosing scope. A caller that does not opt in gets exactly the previous behaviour, one client per transaction.

It is a scope rather than a module-level client because a Worker may not reuse a socket across invocations, so the caller declares what an invocation is — a fetch, a queue batch, a Workflow step — and nothing is assumed to survive past it.

Plain queries deliberately do not move onto this client: the same probe measured Neon HTTP at 6.76 ms per query against the pooled client's 8.02 ms, and an HTTP query costs no connection at all.
