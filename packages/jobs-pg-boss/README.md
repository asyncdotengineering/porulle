# `@porulle/jobs-pg-boss`

Postgres-native Porulle execution engine backed by pg-boss. It maps task retries, delayed enqueue, keyed exclusivity, and pending-job supersession onto pg-boss queue policies and workers.

```ts
import { PgBossExecutionEngine } from "@porulle/jobs-pg-boss";

const jobs = new PgBossExecutionEngine({
  connectionString: process.env.DATABASE_URL!,
});

export default defineConfig({ jobs: { adapter: jobs } });
await jobs.start();
```
