# @porulle/jobs-cloudflare

## 0.47.0

### Patch Changes

- Updated dependencies [[`71ace6a`](https://github.com/asyncdotengineering/porulle/commit/71ace6a67d7dcae1602f2bbf6d91c97435a06ec8)]:
  - @porulle/core@0.47.0

## 0.46.0

### Patch Changes

- Updated dependencies [[`63d0562`](https://github.com/asyncdotengineering/porulle/commit/63d0562af8c12314509545a6c4379946b9629e6f)]:
  - @porulle/core@0.46.0

## 0.45.0

### Patch Changes

- Updated dependencies [[`1e3ea65`](https://github.com/asyncdotengineering/porulle/commit/1e3ea6566ed1cd5dac9388af5511835d42e7f466)]:
  - @porulle/core@0.45.0

## 0.44.0

### Patch Changes

- Updated dependencies [[`adf43da`](https://github.com/asyncdotengineering/porulle/commit/adf43da78b7d48baf8a2074a65b759a1bee6df2f), [`74a4a60`](https://github.com/asyncdotengineering/porulle/commit/74a4a6040cef90e420e780a3deb189857db7a15a), [`05b4efc`](https://github.com/asyncdotengineering/porulle/commit/05b4efc72374f5787d91c85321c90a3f43fbc436)]:
  - @porulle/core@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [[`e9f1de6`](https://github.com/asyncdotengineering/porulle/commit/e9f1de6d18a35e706153c2e596799d35c00ffbc2)]:
  - @porulle/core@0.42.0

## 0.41.0

### Patch Changes

- Updated dependencies [[`7f3dacc`](https://github.com/asyncdotengineering/porulle/commit/7f3daccf2c40ce2425ae34badff43086cec4df66)]:
  - @porulle/core@0.41.0

## 0.40.1

### Patch Changes

- Updated dependencies [[`bc1ca17`](https://github.com/asyncdotengineering/porulle/commit/bc1ca17f168ef3c6bbad5eec2144cf4e5853b912)]:
  - @porulle/core@0.40.1

## 0.40.0

### Patch Changes

- Updated dependencies [[`c16c3fa`](https://github.com/asyncdotengineering/porulle/commit/c16c3fa44a4bb662a75dd28362faea9f8697eecf)]:
  - @porulle/core@0.40.0

## 0.39.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [[`26b2da1`](https://github.com/asyncdotengineering/porulle/commit/26b2da16f4fe03a28566d91d6ca7aa4f46fea3c5)]:
  - @porulle/core@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies [[`f28bef1`](https://github.com/asyncdotengineering/porulle/commit/f28bef11a0ae73b1011aa29f7772d2c8fa6b05cd)]:
  - @porulle/core@0.37.0

## 0.36.0

### Patch Changes

- Updated dependencies [[`1603287`](https://github.com/asyncdotengineering/porulle/commit/1603287a8a47a0ad4f5d14cc3a6e6b339cdee31d), [`9527725`](https://github.com/asyncdotengineering/porulle/commit/952772518cc07e2fedc8792847c3a9d22072f0e9)]:
  - @porulle/core@0.36.0

## 0.35.1

### Patch Changes

- Updated dependencies [[`93715ed`](https://github.com/asyncdotengineering/porulle/commit/93715ededae7c8fb35f1d2c81637136e8a887501)]:
  - @porulle/core@0.35.1

## 0.35.0

### Patch Changes

- Updated dependencies [[`217f9a6`](https://github.com/asyncdotengineering/porulle/commit/217f9a6f80630d66f50fa06a00322656bda9f61b)]:
  - @porulle/core@0.35.0

## 0.34.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [[`bc4328b`](https://github.com/asyncdotengineering/porulle/commit/bc4328badd48a76be1c31df349e881a2a66359be)]:
  - @porulle/core@0.33.0

## 0.32.0

### Minor Changes

- [#113](https://github.com/asyncdotengineering/porulle/pull/113) [`fdcc79b`](https://github.com/asyncdotengineering/porulle/commit/fdcc79b040814bae11f901e1124b1eb1b6b08fdf) Thanks [@octalpixel](https://github.com/octalpixel)! - Stop a terminated instance from absorbing every later enqueue on its key

  0.31.0 added input-equality coalescing: a superseding enqueue whose input hash matches an id already in `pending` returns that id, and `DurableObjectConcurrencyCoordinator.enqueue` returns it **without creating an instance**. That made `pending` load-bearing without ever checking the instance behind it still exists — and nothing removes a pending id when its instance dies. `grantKey` removes it only when it acquires, `release` only when it is next in line, and a supersede drops it only when the input _differs_.

  So one instance terminated before it took a turn absorbed every later enqueue carrying the same input, on that key, forever, and the caller was told the enqueue succeeded. Measured on a deployed Worker on 2026-09-15: an instance terminated through the API at 01:02 left an operator route answering 202 and creating no Workflow instance at all for the rest of the day. Before 0.31.0 that enqueue superseded — it terminated the pending id and created — so a dead pending id could not block a key. This release repairs that regression.

  `enqueue` now gets the same staleness check `acquire` already had, in the same shape: `JobCoordinatorLogic.enqueue` is replaced by `enqueueRead` (storage only, returning a `coalesceCandidate` rather than a decision), and the Durable Object asks the Workflow binding **outside** `blockConcurrencyWhile` before re-entering through `enqueueAfterLiveCandidate` or `enqueueAfterStaleCandidate`, each of which re-reads current state. Coalescing into a live pending instance is unchanged; coalescing into a dead one now supersedes it instead.

  **Breaking for direct callers of `JobCoordinatorLogic.enqueue`** — the pure state machine's single-call enqueue is gone, because a second entry point that still coalesces without a liveness check is the same bug under another name. The `CoordinatorStub` RPC surface, `porulleJobCoordinator`'s `enqueue`, and `DurableObjectConcurrencyCoordinator` are unchanged.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.32.0

## 0.31.0

### Minor Changes

- [#112](https://github.com/asyncdotengineering/porulle/pull/112) [`d05152a`](https://github.com/asyncdotengineering/porulle/commit/d05152a635b1d25f59610c6da62615722b52526f) Thanks [@octalpixel](https://github.com/octalpixel)! - Finish a store's inventory sync, and stop creating a Workflow instance per enqueue

  Three changes, one finding: work that scaled with inventory LEVELS where it should have scaled
  with PRODUCTS.

  Measured on a deployed Worker on 2026-09-14, one operator sweep of a 100-product store:
  `channel/sync-inventory` was killed by `WorkflowTimeoutError: Execution timed out after 600000ms`
  having written **232 of ~1,299 levels**, leaving **23 of 104 products** with any stock at all. The
  600,000 ms is Cloudflare's documented default `WorkflowStepConfig.timeout` of ten minutes, per
  attempt — nothing in this repository sets it. Raising it is not the fix: a 1,000-product merchant is
  roughly 13,000 levels, which at the measured 2.6 s each is about nine hours in a single attempt that
  discards everything if it fails.

  **`syncInventory` is bounded and resumable**, the way `importCatalog` already was. It processes at
  most `CHANNEL_INVENTORY_MAX_ITEMS_PER_INVOCATION` levels from a resume position persisted on
  `connected_stores.inventory_cursor`, returns `{ synced, exhausted }`, and the task enqueues its own
  continuation until the store is drained. The bound counts levels **walked**, never work done: a sync
  where nothing has changed does no work at all, and a bound on work would not bound it. Because the
  cursor now holds a position, the last-sync time moved to `connected_stores.lastSyncAt`; a cursor
  written by an earlier release is read as "start from the beginning".

  **A superseding enqueue coalesces before a Workflow instance exists.** Previously every enqueue
  created an instance and the supersede terminated the one before it, so N enqueues on one key meant N
  instances, N coordinator round trips and N−1 terminations to run one job — **1,303 instances to run
  at most 104 jobs** in the sweep above. An enqueue whose key already has a pending, not-yet-started
  instance with an identical input now reuses it. A differing input still terminates and replaces, so
  supersede stays latest-wins; an instance that has already started is never coalesced into, because
  it has read its input.

  **The concurrency gate no longer holds network I/O.** `release` looped `workflow.get` and
  `sendEvent` inside `blockConcurrencyWhile`, and `acquire`'s stale-holder check made a binding call
  under it too — so `porulle-turn:acquire` was observed held for 33 seconds and the Durable Object was
  reset with "A call to blockConcurrencyWhile() waited for too long". `release` now computes the next
  holder inside the gate and wakes outside it, and `acquire` reads state inside, asks about staleness
  outside, then re-enters and decides against the state as it is then. That re-read is what keeps two
  concurrent acquirers finding a dead holder from both being granted.

  Coordinator state written by an earlier release is read without a migration: `pendingHashes` is
  backfilled on read, so an object does not crash on its own history.

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.31.0

## 0.30.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.30.0

## 0.29.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [[`687c7df`](https://github.com/asyncdotengineering/porulle/commit/687c7dfb546b023a9686b4af3ed446719b16b2fc)]:
  - @porulle/core@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [[`8fd3716`](https://github.com/asyncdotengineering/porulle/commit/8fd3716a5fb5974c4a2b55f2d9a6bfecd6855a4a)]:
  - @porulle/core@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [[`45b8c18`](https://github.com/asyncdotengineering/porulle/commit/45b8c18fa6ab40664794c0e8c7cefb69d60ba69c)]:
  - @porulle/core@0.25.0

## 0.24.1

### Patch Changes

- Updated dependencies [[`37c51fe`](https://github.com/asyncdotengineering/porulle/commit/37c51feb3dfad82fd6cf8e63dc18b07ea1b5caf5)]:
  - @porulle/core@0.24.1

## 0.24.0

### Patch Changes

- Updated dependencies [[`6832853`](https://github.com/asyncdotengineering/porulle/commit/6832853d83b02b5ba83c8e4008e4ec36b5e210eb)]:
  - @porulle/core@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [[`cf30ee4`](https://github.com/asyncdotengineering/porulle/commit/cf30ee485b8050f393452a1bed7adf3e2bacc558)]:
  - @porulle/core@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [[`0a719cd`](https://github.com/asyncdotengineering/porulle/commit/0a719cd9cbf6836f513b642e566e82d16ea3e97c)]:
  - @porulle/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [[`f6d69fb`](https://github.com/asyncdotengineering/porulle/commit/f6d69fbe64165b2e9a6bd892ba433f69273f8dee)]:
  - @porulle/core@0.21.0

## 0.20.3

### Patch Changes

- Updated dependencies [[`17f743c`](https://github.com/asyncdotengineering/porulle/commit/17f743c2c4a7c08f111561748d140f84c214a60d)]:
  - @porulle/core@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [[`ad671d2`](https://github.com/asyncdotengineering/porulle/commit/ad671d223368be15e1517917527dc2aa9c0f105e)]:
  - @porulle/core@0.20.2

## 0.20.1

### Patch Changes

- Updated dependencies [[`8ba7ebf`](https://github.com/asyncdotengineering/porulle/commit/8ba7ebfe90286c9bbc07651458c596aaa004b070)]:
  - @porulle/core@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [[`e99bf87`](https://github.com/asyncdotengineering/porulle/commit/e99bf873d09fcb00bae42845b04f23e126e1293c)]:
  - @porulle/core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [[`d98a0cf`](https://github.com/asyncdotengineering/porulle/commit/d98a0cf04578f4c89a758a3544a5a7bc99e9444c)]:
  - @porulle/core@0.19.0

## 0.18.0

### Minor Changes

- [#94](https://github.com/asyncdotengineering/porulle/pull/94) [`7ca0da4`](https://github.com/asyncdotengineering/porulle/commit/7ca0da4237e05f890d403397d839eccc27bb5900) Thanks [@octalpixel](https://github.com/octalpixel)! - `@porulle/jobs-cloudflare` is now production-ready for Cloudflare Workflows:

  - `TaskContext.step` gives a task handler durable, per-phase execution (`do`/`sleep`). A task that sets the new `TaskDefinition.durableSteps: true` runs in the Workflow body and the Cloudflare engine backs `ctx.step` with the Workflow's own top-level steps (named `porulle:<slug>:<name>`, each with its own retries and timeout) instead of retrying the whole handler as one unit; other tasks keep the single retried step and get a pass-through `ctx.step`, as does every task on the drizzle engine, so a handler written against `ctx.step` runs unchanged on both. Retry counts now follow Porulle's `attempts` (Cloudflare's `limit` is `attempts - 1`).
  - `TaskNonRetryableError` (new in `@porulle/core`, also exported from the new leaf entry `@porulle/core/jobs`) lets a handler or step refuse a retry outright. The Cloudflare engine rethrows it inside the step as the `NonRetryableError` class the Worker passes in through the new required `nonRetryableError` option; the drizzle runner fails the job immediately, ignoring remaining attempts.
  - `DurableObjectConcurrencyCoordinator` and the `porulleJobCoordinator(DurableObject)` Durable Object mixin give Cloudflare Workflows a real coordinator for keyed tasks: `supersedes` terminates pending same-key instances at enqueue, and `exclusive` serializes same-key instances through the Durable Object, parking a losing instance with `step.waitForEvent` until its turn.
  - `adaptWorkflowBinding(env.PORULLE_WORKFLOW)` wraps the real binding, folding Cloudflare's instance status onto `JobInstanceStatus`.
  - `CloudflareExecutionEngine.status`/`.cancel` (and the matching optional `JobsAdapter.status`/`.cancel`, implemented by the drizzle adapter) report an instance's state and terminate it.
  - `EnqueueOptions.jobId` is used verbatim as the job id — the Workflow instance id on Cloudflare, the `commerce_jobs` row id on the drizzle engine — so a caller can address the job it created ("one generation, one instance").
  - `DrizzleJobsAdapter.cancel` marks a pending row `cancelled` (a new `commerce_jobs.status` value) instead of deleting it, so `status()` reports it as `terminated`.

  Breaking for implementers of this package's interfaces (0.x): `CloudflareExecutionEngineOptions.nonRetryableError` is required; `WorkflowBinding.get`, `WorkflowStep.waitForEvent` and `CloudflareJobPayload.jobId` are now required; `CloudflareConcurrencyCoordinator.run` takes `(payload, step, handler)` instead of `(key, handler)`. Apps that only consume `CloudflareExecutionEngine` with the real bindings need to add the `nonRetryableError` option.

### Patch Changes

- Updated dependencies [[`7ca0da4`](https://github.com/asyncdotengineering/porulle/commit/7ca0da4237e05f890d403397d839eccc27bb5900)]:
  - @porulle/core@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [[`4bc5a61`](https://github.com/asyncdotengineering/porulle/commit/4bc5a6137a01a2f221c4d1ba0c8d22d7e80b7f56)]:
  - @porulle/core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [[`983bc69`](https://github.com/asyncdotengineering/porulle/commit/983bc696af361445cf5d19b4d69b1a9f4a25fb83)]:
  - @porulle/core@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [[`dd59c5c`](https://github.com/asyncdotengineering/porulle/commit/dd59c5cd0d456d90b0cfb0af6b744a2520dc8f57)]:
  - @porulle/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [[`3f1de20`](https://github.com/asyncdotengineering/porulle/commit/3f1de204f0ebb07f634fe702ddc8a6f1d6fd7f22), [`0583eab`](https://github.com/asyncdotengineering/porulle/commit/0583eab02f80869f3aba3fdc2ae847712cbd6959), [`f476b2c`](https://github.com/asyncdotengineering/porulle/commit/f476b2c2687dc4bed24de65a1ab1abdf08853066), [`32136d4`](https://github.com/asyncdotengineering/porulle/commit/32136d49df43995e167e1198d1b768976e1eb85f)]:
  - @porulle/core@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies [[`6cfb51d`](https://github.com/asyncdotengineering/porulle/commit/6cfb51debf27bb2f9bac26320d95414bf3443905), [`98e75bb`](https://github.com/asyncdotengineering/porulle/commit/98e75bb0222d9079589d97dca74de0f0dda4e12c), [`8c2c116`](https://github.com/asyncdotengineering/porulle/commit/8c2c1160acf87b981b3be8606918cde057fed833), [`4f9e5b9`](https://github.com/asyncdotengineering/porulle/commit/4f9e5b939b72849b943de6fe2d2751dac8d6caba), [`5ee7ae3`](https://github.com/asyncdotengineering/porulle/commit/5ee7ae3628acb29ea56738423c8cfe5e10d26182), [`0948324`](https://github.com/asyncdotengineering/porulle/commit/0948324c22f1468dfeb73707f6f77d182bc58494), [`54bf6cf`](https://github.com/asyncdotengineering/porulle/commit/54bf6cfcb5f45b46cecdd9a1568a104ae647817c), [`f36de3a`](https://github.com/asyncdotengineering/porulle/commit/f36de3a4524c67eb79badeeb2a33f3502c75bf18), [`cf611f9`](https://github.com/asyncdotengineering/porulle/commit/cf611f9f6b21a4dd3eaee7e3cab8c9f7d2faf431), [`7688ce2`](https://github.com/asyncdotengineering/porulle/commit/7688ce2eb4e1eea74a9ec0bfab90cdb74078bcc6), [`bc5c825`](https://github.com/asyncdotengineering/porulle/commit/bc5c825919d3f0cbbf4849cdefb72b61c430fb0d), [`d6f27f6`](https://github.com/asyncdotengineering/porulle/commit/d6f27f6b24cb0de70b77529f81d0677d0b235a5f)]:
  - @porulle/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.11.0

## 0.10.8

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.8

## 0.10.6

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.6

## 0.10.5

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.5

## 0.10.4

### Patch Changes

- Updated dependencies [[`26a5a72`](https://github.com/asyncdotengineering/porulle/commit/26a5a722ae2e2a94d284e71f8e824ab2c985cce0)]:
  - @porulle/core@0.10.4

## 0.10.3

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.2

## 0.10.1

### Patch Changes

- Updated dependencies []:
  - @porulle/core@0.10.1

## 0.10.0

### Minor Changes

- [#77](https://github.com/asyncdotengineering/porulle/pull/77) [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce) Thanks [@octalpixel](https://github.com/octalpixel)! - Enforce keyed job concurrency in the built-in runner and add swappable execution engines for pg-boss, Inngest, Trigger.dev, and Cloudflare Workflows.

### Patch Changes

- Updated dependencies [[`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`8f8c564`](https://github.com/asyncdotengineering/porulle/commit/8f8c564deb399a86c50d27d8ca07e5334888bf30), [`ff3d5e6`](https://github.com/asyncdotengineering/porulle/commit/ff3d5e6e876f090119fd025aa6b5499f0dccd9fb), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce), [`22e0be4`](https://github.com/asyncdotengineering/porulle/commit/22e0be4eca991f78aed7f458306a399c9dc7c8ce)]:
  - @porulle/core@0.10.0

See repository changesets for release history.
