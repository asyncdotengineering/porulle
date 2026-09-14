---
"@porulle/plugin-channel-connector": minor
---

Walk a batched sweep's batches inside one job instance instead of chaining a successor per batch.

`channel/import-catalog` and `channel/sync-inventory` each created their own
successor by enqueueing from inside the running instance. On Cloudflare that
spends one of a request chain's **32 Worker invocations** per batch, and they
never come back, so a chain of any length dies part-way through with
`Subrequest depth limit exceeded` — at the coordinator call, before the handler
runs, which is why the cursor survives and the catalog merely looks incomplete.

Both tasks are now `durableSteps` handlers that walk their batches to
exhaustion as successive top-level steps of one instance. A step spends no
chain depth, so the walk is flat however many batches it takes. The per-batch
bound, the cursor format and the resume behaviour are unchanged — only the
wrapper moved.

Each step's name carries its batch index. The engine keys a step by name and
replays a repeat, so a loop that reuses one name finishes instantly and writes
a single batch.

The import still hands off to inventory exactly once when the catalog is whole:
one enqueue of a *different* task, costing a single level rather than one per
page.

`CHANNEL_MAX_BATCHES_PER_SWEEP` turns a cursor that stops advancing into a
refusal that names the store, rather than a loop that runs until the step
budget is gone.

**Consumers on Cloudflare should size `limits.subrequests` for a whole
catalog.** The subrequest limit is counted per Workflow *instance*, not per
step, and chaining used to refresh it each time; one instance now carries the
whole sweep.
