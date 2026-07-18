# `@porulle/jobs-trigger`

Push execution engine that translates Porulle tasks into Trigger.dev tasks and enqueues them with the Trigger.dev SDK.

```ts
import { TriggerExecutionEngine } from "@porulle/jobs-trigger";

export const jobs = new TriggerExecutionEngine();
export default defineConfig({ jobs: { adapter: jobs } });
```

Import the module that creates the Porulle kernel from the Trigger.dev task directory. Registration calls Trigger.dev's `task()` API for every configured task; the Trigger.dev runtime then owns execution and retries.
