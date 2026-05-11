import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { CompensationFailuresRepository } from "../src/kernel/compensation/repository.js";
import { compensationFailures } from "../src/kernel/compensation/schema.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";

const ORG_A = "org_default";
const ORG_B = "org_other";

function baseFailureInput(overrides: Partial<{
  organizationId: string;
  correlationId: string;
  chainName: string;
  stepName: string;
}> = {}) {
  return {
    organizationId: ORG_A,
    correlationId: "corr-1",
    chainName: "checkout",
    stepName: "release-inventory",
    originalError: { message: "step failed", code: "STEP_ERR" },
    compensationError: { message: "compensate threw", stack: "stack…" },
    ...overrides,
  };
}

describe("CompensationFailuresRepository (PGlite)", () => {
  let db: Awaited<ReturnType<typeof createPGliteTestAdapter>>["db"];
  let cleanup: () => Promise<void>;
  let repo: CompensationFailuresRepository;

  beforeAll(async () => {
    const adapter = await createPGliteTestAdapter();
    db = adapter.db;
    cleanup = adapter.cleanup;
    repo = new CompensationFailuresRepository(db);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("creates expected indexes on compensation_failures", async () => {
    const raw = await db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'compensation_failures'
      ORDER BY indexname
    `);
    const indexRows = Array.isArray(raw)
      ? (raw as { indexname: string }[])
      : ((raw as { rows?: { indexname: string }[] }).rows ?? []);
    const names = indexRows.map((r) => r.indexname);
    expect(names).toContain("idx_compensation_failures_org_unresolved");
    expect(names).toContain("idx_compensation_failures_correlation");
  });

  it("record() persists a row retrievable from the table", async () => {
    const rec = await repo.record(baseFailureInput({ correlationId: "c-record" }));
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const rows = await db
      .select()
      .from(compensationFailures)
      .where(eq(compensationFailures.id, rec.value.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.correlationId).toBe("c-record");
    expect(rows[0]!.organizationId).toBe(ORG_A);
  });

  it("list({ resolved: false }) returns only unresolved rows", async () => {
    await repo.record(baseFailureInput({ correlationId: "u1" }));
    const resolved = await repo.record(baseFailureInput({ correlationId: "u2" }));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const done = await repo.markResolved({
      id: resolved.value.id,
      organizationId: ORG_A,
      resolvedBy: "user-1",
    });
    expect(done.ok).toBe(true);

    const list = await repo.list({ organizationId: ORG_A, resolved: false });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.items.every((r) => r.resolvedAt == null)).toBe(true);
    expect(list.value.items.some((r) => r.correlationId === "u2")).toBe(false);
  });

  it("list({ resolved: true }) returns only resolved rows", async () => {
    const list = await repo.list({ organizationId: ORG_A, resolved: true });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.items.length).toBeGreaterThan(0);
    expect(list.value.items.every((r) => r.resolvedAt != null)).toBe(true);
  });

  it("getById returns null for same id scoped to a different organization", async () => {
    const rec = await repo.record(
      baseFailureInput({
        organizationId: ORG_A,
        correlationId: "iso-1",
      }),
    );
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const foreign = await repo.getById(rec.value.id, ORG_B);
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    expect(foreign.value).toBeNull();
  });

  it("markResolved updates row when id and org match and row is unresolved", async () => {
    const rec = await repo.record(
      baseFailureInput({ correlationId: "resolve-ok" }),
    );
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const out = await repo.markResolved({
      id: rec.value.id,
      organizationId: ORG_A,
      resolvedBy: "resolver-1",
      notes: "refunded manually",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.resolvedAt).not.toBeNull();
    expect(out.value.resolvedBy).toBe("resolver-1");
    expect(out.value.resolutionNotes).toBe("refunded manually");
  });

  it("markResolved returns Err when row already resolved", async () => {
    const rec = await repo.record(
      baseFailureInput({ correlationId: "re-resolve" }),
    );
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const first = await repo.markResolved({
      id: rec.value.id,
      organizationId: ORG_A,
      resolvedBy: "a",
    });
    expect(first.ok).toBe(true);
    const second = await repo.markResolved({
      id: rec.value.id,
      organizationId: ORG_A,
      resolvedBy: "b",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("NOT_FOUND");
  });

  it("markResolved returns Err for cross-organization id", async () => {
    const rec = await repo.record(
      baseFailureInput({
        organizationId: ORG_A,
        correlationId: "xorg",
      }),
    );
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    const out = await repo.markResolved({
      id: rec.value.id,
      organizationId: ORG_B,
      resolvedBy: "evil",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("NOT_FOUND");
  });
});
