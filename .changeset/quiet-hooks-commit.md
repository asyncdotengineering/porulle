---
"@porulle/core": minor
---

Run after-hooks after the transaction commits, not inside it.

`runAfterHooks` fired while the writing transaction was still open. Measured by
instrumenting the built `deliverWebhooks`: thirteen invocations, ten of them
entering with `tx` non-null. So `catalog.afterCreate` reached
`jobs.enqueue("webhooks/deliver", …)` **before the entity committed**, and a
transaction that rolled back afterwards left the announcement behind.

Whether that announcement survives depends on the adapter, which is worse than
either answer on its own. On a single-connection test adapter the enqueue rides
the same transaction and rolls back with the entity, so every suite looks
correct. On an HTTP driver — Neon, and any driver where a query is its own
request — the enqueue commits independently and outlives the rollback. The
defect is therefore producible only on the deployed path, and no test on the
single-connection adapter can fail on it however it is written.

After-hooks now default to running **after commit**, with `tx` set to `null`
because there is no transaction left to write through. Hooks that must be
atomic with the write — the audit hooks, and any outbox writer — opt in with
`appendInTransaction` / `prependInTransaction` and are unchanged.

The drain lives in `createDatabaseConnection`, which is the one wrapper every
transaction in core, the REST layer and every plugin is handed;
`withTransaction` in `tx-context.ts` is bypassed by most callers, including
plugins that call `db.transaction` directly. A transaction that throws discards
its deferred hooks without running them, and nested transactions drain only at
the outermost boundary, since an inner "commit" is not a commit.

Collection uses `AsyncLocalStorage`, already used elsewhere in this package.

Two consequences worth knowing before upgrading:

- An after-commit hook resolves **after** the service method has returned, so
  its errors can no longer appear in that call's `HookReport.hookErrors`. They
  are logged instead. Awaiting the drain inside the call would put the hook back
  inside the transaction, which is the whole defect.
- A hook that relied on reading `context.tx` now receives `null` unless it opts
  in to running in-transaction. Hooks that write through the outer `context.db`
  are unaffected.

Also removes a large incidental cost: an after-hook blocked behind the very
transaction that was waiting for it timed out after 20 s and was swallowed.
`plugin-channel-connector`'s batched inventory sweep spent 460 s of a 469 s run
in that timeout — and passed, so nothing reported it.
