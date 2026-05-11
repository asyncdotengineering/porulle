import { and, eq, lt, sql } from "drizzle-orm";
import type { DbOrTx } from "../database/drizzle-db.js";
import type { Logger } from "../hooks/types.js";
import { commerceJobs } from "./schema.js";
import type { TaskDefinition } from "./types.js";

export function getJobReapThresholdMs(): number {
  const raw = process.env.JOB_REAP_THRESHOLD_MS;
  if (raw === undefined || raw === "") return 300_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
}

export function getJobsReaperIntervalMs(): number {
  const raw = process.env.JOBS_REAPER_INTERVAL_MS;
  if (raw === undefined || raw === "") return 60_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

export async function runStaleJobReaper(
  db: DbOrTx,
  thresholdMs: number,
  logger: Logger,
): Promise<{ reapedCount: number }> {
  const cutoff = new Date(Date.now() - thresholdMs);

  return db.transaction(async (tx) => {
    const stuck = await tx
      .select({
        id: commerceJobs.id,
        taskSlug: commerceJobs.taskSlug,
        processingStartedAt: commerceJobs.processingStartedAt,
        attempts: commerceJobs.attempts,
      })
      .from(commerceJobs)
      .where(
        and(
          eq(commerceJobs.status, "processing"),
          sql`${commerceJobs.processingStartedAt} IS NOT NULL`,
          lt(commerceJobs.processingStartedAt, cutoff),
        ),
      )
      .for("update");

    let reapedCount = 0;
    for (const row of stuck) {
      const newAttempts = Math.max(row.attempts - 1, 0);
      const updated = await tx
        .update(commerceJobs)
        .set({
          status: "pending",
          processingStartedAt: null,
          attempts: newAttempts,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(commerceJobs.id, row.id),
            eq(commerceJobs.status, "processing"),
            lt(commerceJobs.processingStartedAt, cutoff),
          ),
        )
        .returning({ id: commerceJobs.id });

      if (updated.length === 0) continue;

      reapedCount++;
      logger.info("Reaped stale processing job", {
        id: row.id,
        taskSlug: row.taskSlug,
        processingStartedAt: row.processingStartedAt,
        attemptsAfter: newAttempts,
      });
    }

    return { reapedCount };
  });
}

export const staleJobReaperTask: TaskDefinition<
  Record<string, unknown>,
  { reapedCount: number }
> = {
  slug: "jobs/reap-stale",

  async handler({ ctx }) {
    const reaped = await runStaleJobReaper(
      ctx.db,
      getJobReapThresholdMs(),
      ctx.logger,
    );
    return { output: { reapedCount: reaped.reapedCount } };
  },
};
