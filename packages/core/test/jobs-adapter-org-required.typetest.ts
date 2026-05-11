import type { JobsAdapter } from "../src/kernel/jobs/adapter.js";

declare const jobs: JobsAdapter;

// @ts-expect-error EnqueueOptions.organizationId is required
void jobs.enqueue("x", {}, {});
