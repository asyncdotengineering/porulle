---
"@porulle/core": minor
"@porulle/jobs-cloudflare": minor
---

`@porulle/jobs-cloudflare` is now production-ready for Cloudflare Workflows:

- `TaskContext.step` gives a task handler durable, per-phase execution (`do`/`sleep`). A task that sets the new `TaskDefinition.durableSteps: true` runs in the Workflow body and the Cloudflare engine backs `ctx.step` with the Workflow's own top-level steps (named `porulle:<slug>:<name>`, each with its own retries and timeout) instead of retrying the whole handler as one unit; other tasks keep the single retried step and get a pass-through `ctx.step`, as does every task on the drizzle engine, so a handler written against `ctx.step` runs unchanged on both. Retry counts now follow Porulle's `attempts` (Cloudflare's `limit` is `attempts - 1`).
- `TaskNonRetryableError` (new in `@porulle/core`, also exported from the new leaf entry `@porulle/core/jobs`) lets a handler or step refuse a retry outright. The Cloudflare engine rethrows it inside the step as the `NonRetryableError` class the Worker passes in through the new required `nonRetryableError` option; the drizzle runner fails the job immediately, ignoring remaining attempts.
- `DurableObjectConcurrencyCoordinator` and the `porulleJobCoordinator(DurableObject)` Durable Object mixin give Cloudflare Workflows a real coordinator for keyed tasks: `supersedes` terminates pending same-key instances at enqueue, and `exclusive` serializes same-key instances through the Durable Object, parking a losing instance with `step.waitForEvent` until its turn.
- `adaptWorkflowBinding(env.PORULLE_WORKFLOW)` wraps the real binding, folding Cloudflare's instance status onto `JobInstanceStatus`.
- `CloudflareExecutionEngine.status`/`.cancel` (and the matching optional `JobsAdapter.status`/`.cancel`, implemented by the drizzle adapter) report an instance's state and terminate it.
- `EnqueueOptions.jobId` is used verbatim as the job id — the Workflow instance id on Cloudflare, the `commerce_jobs` row id on the drizzle engine — so a caller can address the job it created ("one generation, one instance").
- `DrizzleJobsAdapter.cancel` marks a pending row `cancelled` (a new `commerce_jobs.status` value) instead of deleting it, so `status()` reports it as `terminated`.

Breaking for implementers of this package's interfaces (0.x): `CloudflareExecutionEngineOptions.nonRetryableError` is required; `WorkflowBinding.get`, `WorkflowStep.waitForEvent` and `CloudflareJobPayload.jobId` are now required; `CloudflareConcurrencyCoordinator.run` takes `(payload, step, handler)` instead of `(key, handler)`. Apps that only consume `CloudflareExecutionEngine` with the real bindings need to add the `nonRetryableError` option.
