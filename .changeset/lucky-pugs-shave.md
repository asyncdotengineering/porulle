---
"@porulle/jobs-cloudflare": minor
---

Stop a terminated instance from absorbing every later enqueue on its key

0.31.0 added input-equality coalescing: a superseding enqueue whose input hash matches an id already in `pending` returns that id, and `DurableObjectConcurrencyCoordinator.enqueue` returns it **without creating an instance**. That made `pending` load-bearing without ever checking the instance behind it still exists — and nothing removes a pending id when its instance dies. `grantKey` removes it only when it acquires, `release` only when it is next in line, and a supersede drops it only when the input *differs*.

So one instance terminated before it took a turn absorbed every later enqueue carrying the same input, on that key, forever, and the caller was told the enqueue succeeded. Measured on a deployed Worker on 2026-09-15: an instance terminated through the API at 01:02 left an operator route answering 202 and creating no Workflow instance at all for the rest of the day. Before 0.31.0 that enqueue superseded — it terminated the pending id and created — so a dead pending id could not block a key. This release repairs that regression.

`enqueue` now gets the same staleness check `acquire` already had, in the same shape: `JobCoordinatorLogic.enqueue` is replaced by `enqueueRead` (storage only, returning a `coalesceCandidate` rather than a decision), and the Durable Object asks the Workflow binding **outside** `blockConcurrencyWhile` before re-entering through `enqueueAfterLiveCandidate` or `enqueueAfterStaleCandidate`, each of which re-reads current state. Coalescing into a live pending instance is unchanged; coalescing into a dead one now supersedes it instead.

**Breaking for direct callers of `JobCoordinatorLogic.enqueue`** — the pure state machine's single-call enqueue is gone, because a second entry point that still coalesces without a liveness check is the same bug under another name. The `CoordinatorStub` RPC surface, `porulleJobCoordinator`'s `enqueue`, and `DurableObjectConcurrencyCoordinator` are unchanged.
