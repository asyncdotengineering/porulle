import { asc } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { runPendingJobs } from "../src/kernel/jobs/runner.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import type { TaskDefinition } from "../src/kernel/jobs/types.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

/**
 * A concurrency key belongs to its TASK, not to the whole table.
 *
 * The enqueue half of this feature has always agreed: `supersedes` deletes pending jobs matching
 * `(organizationId, taskSlug, concurrencyKey)`, so one task can never supersede another's work.
 * The claim half compared the key ALONE — no task filter in the `oldestByKey` slot and none in the
 * `processing` set — so two unrelated tasks that happened to key on the same entity id were
 * treated as one exclusive resource. Measured downstream on 2026-09-13: a catalog projection and a
 * Shopify image push, different plugins, both keyed on an entity id, four runnable jobs in a drain
 * of ten, `{ processed: 2, failed: 0 }` — the pushes released back to pending and, with one drain
 * per tick, never run at all. The symptom appeared in the Shopify feature, three layers from the
 * cause, and read as a broken push.
 *
 * The same-slug behaviour these rows must NOT disturb is pinned next door in
 * `jobs-runner-concurrency.test.ts`: two jobs of one slug sharing a key still run one per cycle.
 * That file is the control for over-scoping this fix, which is why it is not copied here.
 */

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function keyedTask(slug: string, handled: string[]): TaskDefinition {
  return {
    slug,
    concurrency: { key: (input) => String(input.key) },
    handler: async () => {
      handled.push(slug);
      return { output: {} };
    },
  };
}

describe("runPendingJobs — a concurrency key is scoped to its task", () => {
  it("runs two different tasks that share a concurrency key in the same cycle", async () => {
    const { db } = await createPGliteTestAdapter();
    const handled: string[] = [];
    const projection = keyedTask("test/project-entity", handled);
    const push = keyedTask("test/image-push", handled);
    const tasks = new Map([
      [projection.slug, projection],
      [push.slug, push],
    ]);
    const jobs = new DrizzleJobsAdapter(db, tasks);

    // Enqueued in the order the real system produces them: the entity changes, so it is projected,
    // and the same change queues the image push a moment later. The projection is older, which is
    // what made it win the slot.
    await jobs.enqueue(projection.slug, { key: "entity-1" }, { organizationId: DEFAULT_ORG_ID });
    await jobs.enqueue(push.slug, { key: "entity-1" }, { organizationId: DEFAULT_ORG_ID });

    const cycle = await runPendingJobs({ db, tasks, logger, services: {} });
    const rows = await db.select().from(commerceJobs).orderBy(asc(commerceJobs.createdAt));

    expect(cycle).toEqual({ processed: 2, failed: 0 });
    expect(handled.sort()).toEqual(["test/image-push", "test/project-entity"]);
    expect(rows.map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("does not let one task's in-flight job block another task's job on the same key", async () => {
    const { db } = await createPGliteTestAdapter();
    const handled: string[] = [];
    const projection = keyedTask("test/project-entity", handled);
    const push = keyedTask("test/image-push", handled);
    const tasks = new Map([
      [projection.slug, projection],
      [push.slug, push],
    ]);
    const jobs = new DrizzleJobsAdapter(db, tasks);

    // The other unfiltered comparison: the claim transaction reads every row whose status is
    // `processing` and refuses any exclusive candidate whose key appears there, regardless of which
    // task is holding it. A projection genuinely in flight must not stop the push.
    await jobs.enqueue(projection.slug, { key: "entity-1" }, { organizationId: DEFAULT_ORG_ID });
    await db.update(commerceJobs).set({ status: "processing", processingStartedAt: new Date() });
    await jobs.enqueue(push.slug, { key: "entity-1" }, { organizationId: DEFAULT_ORG_ID });

    const cycle = await runPendingJobs({ db, tasks, logger, services: {} });

    expect(cycle).toEqual({ processed: 1, failed: 0 });
    expect(handled).toEqual(["test/image-push"]);
  });
});
