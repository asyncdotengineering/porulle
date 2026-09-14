---
"@porulle/jobs-cloudflare": minor
"@porulle/plugin-channel-connector": minor
---

Finish a store's inventory sync, and stop creating a Workflow instance per enqueue

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
