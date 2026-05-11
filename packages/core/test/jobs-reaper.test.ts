import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import { runStaleJobReaper } from "../src/kernel/jobs/reaper.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

describe("stale job reaper (S2-06)", () => {
  it("reverts stale processing jobs older than threshold and decrements attempts", async () => {
    const { db } = await createPGliteTestAdapter();
    const fiveMinMs = 5 * 60 * 1000;

    const [oldJob] = await db
      .insert(commerceJobs)
      .values({
        organizationId: DEFAULT_ORG_ID,
        queue: "default",
        taskSlug: "webhooks/deliver",
        status: "processing",
        attempts: 3,
        processingStartedAt: new Date(Date.now() - 10 * 60 * 1000),
        maxAttempts: 5,
      })
      .returning();

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runStaleJobReaper(db as DrizzleDatabase, fiveMinMs, logger);

    const [row] = await db.select().from(commerceJobs).where(eq(commerceJobs.id, oldJob!.id));

    expect(row!.status).toBe("pending");
    expect(row!.processingStartedAt).toBeNull();
    expect(row!.attempts).toBe(2);

    expect(logger.info).toHaveBeenCalledWith(
      "Reaped stale processing job",
      expect.objectContaining({
        id: oldJob!.id,
        taskSlug: "webhooks/deliver",
        attemptsAfter: 2,
      }),
    );
  });

  it("does not reap processing jobs within the threshold", async () => {
    const { db } = await createPGliteTestAdapter();
    const fiveMinMs = 5 * 60 * 1000;

    const [recentJob] = await db
      .insert(commerceJobs)
      .values({
        organizationId: DEFAULT_ORG_ID,
        queue: "default",
        taskSlug: "webhooks/deliver",
        status: "processing",
        attempts: 2,
        processingStartedAt: new Date(Date.now() - 1 * 60 * 1000),
        maxAttempts: 5,
      })
      .returning();

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await runStaleJobReaper(db as DrizzleDatabase, fiveMinMs, logger);

    const [row] = await db.select().from(commerceJobs).where(eq(commerceJobs.id, recentJob!.id));

    expect(row!.status).toBe("processing");
    expect(row!.attempts).toBe(2);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
