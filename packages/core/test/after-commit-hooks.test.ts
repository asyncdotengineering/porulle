import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allowHookFailure } from "../src/test-utils/hook-failures.js";
import { eq } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import { createTxContext } from "../src/kernel/database/tx-context.js";
import type { ExecutionEngine } from "../src/kernel/jobs/adapter.js";
import { runAfterHooks } from "../src/kernel/hooks/executor.js";
import type { AfterHook, HookContext } from "../src/kernel/hooks/types.js";
import { auditLog } from "../src/modules/audit/schema.js";
import { sellableEntities } from "../src/modules/catalog/schema.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import type { PGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { NullJobsAdapter } from "../src/kernel/jobs/adapter.js";
import type { PluginDb } from "../src/kernel/database/plugin-types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

describe("after-commit hooks", () => {
  let adapter: PGliteTestAdapter;
  let db: DrizzleDatabase;
  let cleanup: () => Promise<void>;
  let kernel: ReturnType<typeof createKernel>;
  const enqueues: Array<{ slug: string; inTransaction: boolean }> = [];

  const actor: Actor = {
    type: "user",
    userId: "after-commit-hooks-1",
    email: "ach@test.local",
    name: "After Commit Hooks",
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "admin",
    permissions: ["*:*"],
  };

  beforeAll(async () => {
    const harness = await createPGliteTestAdapter();
    adapter = harness.adapter;
    db = harness.db;
    cleanup = harness.cleanup;

    const jobsAdapter: ExecutionEngine = {
      execution: { mode: "push" },
      register() {},
      async enqueue(slug) {
        enqueues.push({ slug, inTransaction: adapter.inTransaction() });
        return randomUUID();
      },
    };

    const config = await createTestConfig({
      databaseAdapter: adapter,
      jobs: { adapter: jobsAdapter },
    });
    kernel = createKernel(config);

    await registerCatalogCreateWebhookEndpoint();
  });

  afterAll(async () => {
    await cleanup();
  });

  async function registerCatalogCreateWebhookEndpoint(): Promise<void> {
    const endpoint = await kernel.services.webhooks.createEndpoint(
      {
        url: "https://example.com/webhook",
        secret: "test-secret",
        events: ["catalog.create"],
      },
      actor,
    );
    expect(endpoint.ok).toBe(true);
  }

  beforeEach(async () => {
    enqueues.length = 0;
    await cleanup();
    await registerCatalogCreateWebhookEndpoint();
  });

  it("deliverWebhooks enqueues only after the write transaction commits", async () => {
    const res = await kernel.services.catalog.create(
      {
        type: "product",
        slug: `ach-catalog-${Date.now()}`,
        attributes: { locale: "en", title: "After Commit" },
      },
      actor,
    );
    expect(res.ok).toBe(true);

    const webhookEnqueues = enqueues.filter((e) => e.slug === "webhooks/deliver");
    expect(webhookEnqueues.length).toBeGreaterThan(0);
    expect(enqueues.filter((e) => e.inTransaction)).toEqual([]);
  });

  it("rolls back webhook enqueues when the transaction aborts", async () => {
    const slug = `ach-rollback-${Date.now()}`;
    let entityId: string | undefined;

    await expect(
      kernel.database.transaction(async (tx) => {
        const res = await kernel.services.catalog.create(
          {
            type: "product",
            slug,
            attributes: { locale: "en", title: "Rollback" },
          },
          actor,
          createTxContext(tx, { actor }),
        );
        expect(res.ok).toBe(true);
        if (res.ok) entityId = res.value.id;
        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");

    expect(enqueues.filter((e) => e.slug === "webhooks/deliver")).toEqual([]);
    expect(entityId).toBeDefined();
    const rows = await db
      .select()
      .from(sellableEntities)
      .where(eq(sellableEntities.id, entityId!));
    expect(rows).toEqual([]);
  });

  it("audit hooks stay inside the transaction", async () => {
    const slug = `ach-audit-${Date.now()}`;
    let entityId: string | undefined;

    await expect(
      kernel.database.transaction(async (tx) => {
        const txCtx = createTxContext(tx, { actor });
        const res = await kernel.services.catalog.create(
          {
            type: "product",
            slug,
            attributes: { locale: "en", title: "Audit Inside" },
          },
          actor,
          txCtx,
        );
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        entityId = res.value.id;

        const auditRows = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.entityId, entityId));
        expect(auditRows.length).toBeGreaterThan(0);

        throw new Error("intentional rollback");
      }),
    ).rejects.toThrow("intentional rollback");

    expect(entityId).toBeDefined();
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, entityId!));
    expect(auditRows).toEqual([]);
  });

  // Three assertions, one fixture. The middle one is the reason this row exists: asserting only
  // "it did not run early" is satisfied by a change that never runs the hook AT ALL, so the count
  // is pinned as well as the timing.
  it("nested transactions drain once at the OUTER commit, never at the inner one", async () => {
    let runs = 0;
    let ranWhileAnyTransactionOpen = false;
    let runsAtInnerResolution = -1;

    kernel.hooks.append(
      "catalog.afterCreate",
      (async () => {
        runs += 1;
        if (adapter.inTransaction()) ranWhileAnyTransactionOpen = true;
      }) as AfterHook<unknown>,
    );

    await kernel.database.transaction(async () => {
      await kernel.database.transaction(async (innerTx) => {
        await kernel.services.catalog.create(
          {
            type: "product",
            slug: `ach-nested-${Date.now()}`,
            attributes: { locale: "en", title: "Nested" },
          },
          actor,
          createTxContext(innerTx, { actor }),
        );
      });
      // The inner transaction has RESOLVED. An inner "commit" is not a commit, so nothing may
      // have drained yet.
      expect(runs).toBe(0);
      runsAtInnerResolution = runs;
    });

    expect(runsAtInnerResolution).toBe(0);
    // The outer transaction has now resolved: exactly one run, and it happened after commit.
    expect(runs).toBe(1);
    expect(ranWhileAnyTransactionOpen).toBe(false);
  });

  // The plugin path, which is the one the card exists for and the one every OTHER row in this file
  // misses. A plugin never receives the adapter: it is handed the db HANDLE as `ctx.db` and calls
  // `ctx.db.transaction(...)`. `plugin-channel-connector` constructs its service with no
  // transaction argument in production and imports every product through exactly that call, while
  // its own suites inject `kernel.database.transaction` explicitly — so a fix that covered only
  // the adapter would be green everywhere and inert on the deployed import.
  it("defers hooks for a plugin calling db.transaction directly, not just the adapter", async () => {
    let runs = 0;
    let runsObservedInsideTheBody = -1;

    kernel.hooks.append(
      "catalog.afterCreate",
      (async () => {
        runs += 1;
      }) as AfterHook<unknown>,
    );

    // Deliberately kernel.database.DB.transaction — the handle a plugin gets — and NOT
    // kernel.database.transaction, which the other rows exercise.
    await (kernel.database.db as unknown as {
      transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
    }).transaction(async (tx) => {
      await kernel.services.catalog.create(
        {
          type: "product",
          slug: `ach-plugin-path-${Date.now()}`,
          attributes: { locale: "en", title: "Plugin path" },
        },
        actor,
        createTxContext(tx, { actor }),
      );
      // Read the counter while the transaction body is STILL OPEN. This is the assertion that
      // discriminates, and `adapter.inTransaction()` is not: that flag is set by the test
      // adapter's own transaction() and stays false through drizzle's, so a row keyed on it
      // passes whether or not this path defers. Checked by sabotage.
      runsObservedInsideTheBody = runs;
    });

    expect(runsObservedInsideTheBody).toBe(0);
    expect(runs).toBe(1);
  });

  it("an outer transaction that throws after the inner one resolved drains nothing", async () => {
    let runs = 0;

    kernel.hooks.append(
      "catalog.afterCreate",
      (async () => {
        runs += 1;
      }) as AfterHook<unknown>,
    );

    await expect(
      kernel.database.transaction(async () => {
        await kernel.database.transaction(async (innerTx) => {
          await kernel.services.catalog.create(
            {
              type: "product",
              slug: `ach-outer-abort-${Date.now()}`,
              attributes: { locale: "en", title: "Outer aborts" },
            },
            actor,
            createTxContext(innerTx, { actor }),
          );
        });
        throw new Error("outer transaction fails after the inner one resolved");
      }),
    ).rejects.toThrow("outer transaction fails after the inner one resolved");

    // The inner write is rolled back with the outer transaction, so its announcement must never
    // have been made.
    expect(runs).toBe(0);
  });

  it("runs after-hooks inline with HookReport errors when no transaction is open", async () => {
    // This row exists to make a hook fail, so the standing no-failed-hooks check is told which one.
    allowHookFailure("failingHook");
    const mockDb = { execute: async () => [] } as unknown as PluginDb;
    const context: HookContext = {
      actor: null,
      tx: null,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      services: {},
      context: {},
      requestId: "test",
      origin: "local",
      jobs: new NullJobsAdapter(),
      db: mockDb,
    };

    // With no enclosing transaction there is no store to defer into. The failure mode of getting
    // that wrong is hooks that NEVER fire while every transactional row stays green, so this row
    // pins the count and the ordering, not just the error reporting.
    let runs = 0;
    let ranBeforeRunAfterHooksReturned = false;

    const report = await runAfterHooks(
      [
        async function countingHook() {
          runs += 1;
        },
        async function failingHook() {
          ranBeforeRunAfterHooksReturned = runs === 1;
          throw new Error("inline after-hook failure");
        },
      ],
      null,
      { id: "1" },
      "create",
      context,
    );

    expect(runs).toBe(1);
    expect(ranBeforeRunAfterHooksReturned).toBe(true);
    expect(report.hasErrors).toBe(true);
    expect(report.errors[0]?.message).toContain("inline after-hook failure");
  });
});
