import { describe, expect, it, vi } from "vitest";
import { defineConfig } from "../src/config/define-config.js";
import { defineCommercePlugin } from "../src/kernel/plugin/manifest.js";
import { runPendingJobs } from "../src/kernel/jobs/runner.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";

describe("plugin job registration", () => {
  it("folds plugin jobs into config and runs them", async () => {
    const handled = vi.fn();
    const task: TaskDefinition = {
      slug: "plugin/test-job",
      handler: async ({ input }) => {
        handled(String(input.value));
        return { output: { handled: true } };
      },
    };
    const config = await defineConfig({
      database: { provider: "postgresql" },
      plugins: [defineCommercePlugin({
        id: "test-plugin",
        version: "1.0.0",
        jobs: () => [task],
      })],
    });

    expect(config.jobs?.tasks).toContain(task);

    const { db } = await createPGliteTestAdapter();
    const tasks = new Map(config.jobs!.tasks!.map((entry) => [entry.slug, entry]));
    const adapter = new DrizzleJobsAdapter(db, tasks);
    const jobId = await adapter.enqueue(
      task.slug,
      { value: "ran" },
      { organizationId: DEFAULT_ORG_ID },
    );
    const result = await runPendingJobs({
      db,
      tasks,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      services: {},
    });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(handled).toHaveBeenCalledWith("ran");
    expect((await db.select().from(commerceJobs)).find((job) => job.id === jobId)?.status).toBe("succeeded");
  });
});
