---
"@porulle/core": patch
---

Export `isInsideTransaction` from `@porulle/core/testing`, so a suite can assert that the code under test is really inside an after-commit boundary instead of waiting for the deadlock that a missing one causes. A plugin reaches the database through the `ctx.db` handle rather than the adapter, and the boundary on that path exists only because `normalizeExecuteShape` wraps `transaction`; without it an after-hook runs inside the still-open transaction and blocks on its own connection. That failure is silent — `runAfterHooks` collects after-hook failures into a `HookReport` and never throws.
