# `@porulle/jobs-cloudflare`

Cloudflare Workflows binding adapter and task runner for Porulle. Keyed exclusivity and supersession require a durable coordinator (normally a Durable Object); the adapter fails fast when a keyed task is used without one.

```ts
import { WorkflowEntrypoint } from "cloudflare:workers";
import { CloudflareExecutionEngine } from "@porulle/jobs-cloudflare";

export const jobs = new CloudflareExecutionEngine({
  workflow: env.PORULLE_WORKFLOW,
  coordinator,
});

export class PorulleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return jobs.run(event.payload, step);
  }
}
```

The coordinator must durably supersede pending instances at enqueue and serialize `run()` by concurrency key. Unkeyed tasks can use the Workflow binding directly.
