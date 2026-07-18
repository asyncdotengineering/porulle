# `@porulle/jobs-inngest`

Push execution engine that translates Porulle tasks into Inngest functions. Pass `engine.functions` to your Inngest `serve()` adapter; Inngest owns delivery and retries.

```ts
import { Inngest } from "inngest";
import { serve } from "inngest/hono";
import { InngestExecutionEngine } from "@porulle/jobs-inngest";

const inngest = new Inngest({ id: "store" });
export const jobs = new InngestExecutionEngine({ client: inngest });

export default defineConfig({ jobs: { adapter: jobs } });
export const inngestHandler = serve({
  client: inngest,
  functions: jobs.functions,
});
```

Create the Porulle kernel before serving so task registration has populated `jobs.functions`.
