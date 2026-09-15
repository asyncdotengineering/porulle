---
"@porulle/core": patch
---

Report after-hook failures to an optional observer, and fail a test that causes one.

An after-hook must never fail the write it is announcing, so `runAfterHooks` collects failures into a `HookReport` and the after-COMMIT path cannot even do that — by the time a deferred hook runs, the service method has already returned its Result. The consequence measured on 2026-09-15: removing the after-commit boundary from the plugin db path made four channel-connector suites take 578 s instead of 27 s and log 51 `Hook "deliverWebhooks" timed out after 20000ms`, with exit 0 and every test passing.

`runAfterHooks` now reports each failure to an observer as well as logging it. Production installs none and pays one undefined check; the vitest setup file wired in `vitest.shared.ts` installs one and turns an unallowed failure into a test failure, calling out timeouts specifically because a hook that times out is almost always deadlocked against the transaction it was fired from. A suite that fails a hook on purpose calls `allowHookFailure("<hookName>")`, exported from `@porulle/core/testing`, per test and per hook.
