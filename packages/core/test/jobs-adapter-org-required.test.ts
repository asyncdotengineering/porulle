import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";
import { OrgResolutionError } from "../src/kernel/errors.js";
import { DrizzleJobsAdapter } from "../src/kernel/jobs/drizzle-adapter.js";
import { commerceJobs } from "../src/kernel/jobs/schema.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

describe("DrizzleJobsAdapter organizationId (S1-06 / MT-5)", () => {
  it("inserts job with explicit organizationId", async () => {
    const { db } = await createPGliteTestAdapter();
    const adapter = new DrizzleJobsAdapter(db as DrizzleDatabase, new Map());
    const id = await adapter.enqueue(
      "test/slug",
      { k: 1 },
      { organizationId: DEFAULT_ORG_ID },
    );
    const rows = await db
      .select()
      .from(commerceJobs)
      .where(eq(commerceJobs.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.organizationId).toBe(DEFAULT_ORG_ID);
    expect(rows[0]!.taskSlug).toBe("test/slug");
  });

  it("throws OrgResolutionError when organizationId is empty", async () => {
    const { db } = await createPGliteTestAdapter();
    const adapter = new DrizzleJobsAdapter(db as DrizzleDatabase, new Map());
    await expect(
      adapter.enqueue("t", {}, { organizationId: "" }),
    ).rejects.toThrow(OrgResolutionError);
    await expect(
      adapter.enqueue("t", {}, { organizationId: "   " }),
    ).rejects.toThrow(OrgResolutionError);
  });
});
