---
"@porulle/core": minor
---

Warn when an after-hook takes longer than 100ms.

The only instrument on hook duration was the 20 second timeout, and by the time that fires the cost is already spent. A hook does not have to reach 20 seconds to be a problem: an in-transaction hook holds a pooled Postgres transaction for its whole duration, and an after-commit hook extends the invocation that wrote, because the deferred drain is awaited rather than detached.

`failures.ts` already records what that costs when nobody is watching — four connector suites took 578.23 s instead of 27.29 s and logged 51 `Hook "deliverWebhooks" timed out after 20000ms`, with exit 0 and 22 of 22 tests passing. The only thing that disagreed was the wall clock. A warning at the first slow call surfaces that instead of the fifty-first.

The threshold matches Vendure's blocking-handler warning and the log names the same remedy: move non-trivial work to the job queue and let the hook enqueue it. The warning carries `hookName`, `elapsedMs`, `inTransaction` and `requestId`, and distinguishes the two costs — holding a connection against extending the invocation.

Applies to all three execution paths: in-transaction, deferred after-commit, and the no-store fallback that reads take. Nothing else changes; a slow hook still succeeds.
