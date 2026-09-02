# `@porulle/jobs-cloudflare`

Cloudflare Workflows binding adapter and task runner for Porulle. Keyed exclusivity and supersession require a durable coordinator — this package ships one, `DurableObjectConcurrencyCoordinator`, backed by a `PorulleJobCoordinator` Durable Object; the adapter fails fast when a keyed task is used without one.

## Entrypoint

```ts
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  CloudflareExecutionEngine,
  DurableObjectConcurrencyCoordinator,
  adaptWorkflowBinding,
} from "@porulle/jobs-cloudflare";

// Bindings arrive with the request/event, so build the engine from `env` once you have it.
export function createJobsEngine(env: Env) {
  const workflow = adaptWorkflowBinding(env.PORULLE_WORKFLOW);
  return new CloudflareExecutionEngine({
    workflow,
    // Workflows stops retrying only for this exact class; the package cannot import it itself.
    nonRetryableError: NonRetryableError,
    coordinator: new DurableObjectConcurrencyCoordinator({
      // One Durable Object per coordination key, so keys never queue behind each other.
      stub: (key) => env.PORULLE_JOB_COORDINATOR.get(env.PORULLE_JOB_COORDINATOR.idFromName(key)),
      workflow,
    }),
  });
}

export class PorulleWorkflow extends WorkflowEntrypoint<Env> {
  async run(event, step) {
    const jobs = createJobsEngine(this.env); // register(...) it with your tasks first
    return jobs.run(event.payload, step);
  }
}
```

`adaptWorkflowBinding` folds Cloudflare's instance status onto the six-value `JobInstanceStatus` (`paused`/`waitingForPause` → `waiting`, anything unknown → `errored`) and flattens the error to its message.

Task handlers that need durable, per-phase steps read `ctx.step` — absent on push engines that have not wired one, present here and on the drizzle engine:

```ts
const enrichEntityTask: TaskDefinition = {
  slug: "loom/enrich-entity",
  durableSteps: true,
  handler: async ({ input, ctx }) => {
    const loaded = await ctx.step!.do("load", () => loadEntity(input.entityId));
    const generated = await ctx.step!.do("generate", () => callModel(loaded), {
      timeout: 40_000,
    });
    if (generated.refused) {
      throw new TaskNonRetryableError("Model refused the request");
    }
    await ctx.step!.do("write-ledger", () => writeLedgerRow(generated));
    return { output: generated };
  },
};
```

Steps are never nested. A task that sets `durableSteps: true` runs its handler in the Workflow body: each `ctx.step.do(name, fn, options?)` call becomes its own top-level Workflow step (named `porulle:<slug>:<name>`), retried independently per `options.retries` (falling back to the task's own `retries`), and code between steps re-runs on every wake — keep side effects inside steps. A task without the flag runs as today: one step named `porulle:<slug>` retried as a unit up to `retries.attempts` times, with a pass-through `ctx.step` inside it. `TaskNonRetryableError` — thrown directly, or requested via `options.nonRetryable` — maps to Cloudflare's `NonRetryableError`, so that step (and the instance) does not retry it.

## Coordinator wiring

Add the Durable Object and Workflow bindings to `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "PORULLE_JOB_COORDINATOR", "class_name": "PorulleJobCoordinator" },
    ],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["PorulleJobCoordinator"] }],
  "workflows": [
    { "binding": "PORULLE_WORKFLOW", "name": "porulle-jobs", "class_name": "PorulleWorkflow" },
  ],
}
```

Build the Durable Object class on your Worker's own `DurableObject` base (this package cannot import `cloudflare:workers` itself) and export it from the Worker entrypoint alongside the Workflow:

```ts
import { DurableObject } from "cloudflare:workers";
import { porulleJobCoordinator } from "@porulle/jobs-cloudflare";

export class PorulleJobCoordinator extends porulleJobCoordinator(DurableObject) {}
```

The Durable Object reads `PORULLE_WORKFLOW` from its `env` — the Worker's own bindings, since the class lives in the same script — to detect dead lock holders and wake the next waiting instance.

Per key (`organizationId:taskSlug:concurrencyKey`), `enqueue` terminates every pending instance when `supersedes` is set (never the currently running one — matching the drizzle adapter, only unstarted jobs are dropped). An instance is registered with the coordinator before it is created, so a supersede also terminates instances that exist but have not started running. `run` serializes same-key instances through the DO's `acquire`/`release`; each call is its own Workflow step, so a replay of the body never re-acquires or re-releases. An instance that loses the race parks in `step.waitForEvent` for the turn event and re-acquires when the wait times out — one minute for the first round, doubling to a one-hour ceiling, so waiters recover from a holder cancelled without releasing while a long queue costs tens of steps rather than thousands. A holder the Workflow reports as `complete`, `errored`, `terminated` or no longer knows is treated as gone; a `paused` holder keeps the key.

This package imports only `@porulle/core/jobs` (types and two small helpers), so a Worker bundle does not pull the core server runtime through it. The app's own `commerce.config` still needs whatever compatibility flags it needs.

## Instance status and cancellation

```ts
await jobs.status(jobId); // { status: "running" | "queued" | "waiting" | "complete" | "errored" | "terminated", error? }
await jobs.cancel(jobId); // terminates the Workflow instance
```

`adaptWorkflowBinding` (above) performs the status mapping; a hand-written `WorkflowBinding` must map Cloudflare's richer `InstanceStatus` onto this six-value set itself.

## Node fallback

In local development, or anywhere without the Workers runtime, register the drizzle engine instead — it implements the same `ExecutionEngine` contract (including `status`/`cancel`) against the app's own `commerce_jobs` table and can run tasks in-process:

```ts
import { DrizzleJobsAdapter } from "@porulle/core";

export const jobs = new DrizzleJobsAdapter(db);
// config.jobs.autorun.enabled = true polls commerce_jobs in-process.
```

A handler written against `ctx.step` runs unchanged there — the drizzle engine passes a pass-through `TaskStep` (`do` runs the callback immediately, `sleep` waits in-process).
