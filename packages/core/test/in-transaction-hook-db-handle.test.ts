import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import { defineCommercePlugin } from "../src/kernel/plugin/manifest.js";
import type { HookContext } from "../src/kernel/hooks/types.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createTwoConnectionTestAdapter } from "../src/test-utils/create-two-connection-adapter.js";
import type { TwoConnectionTestAdapter } from "../src/test-utils/create-two-connection-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";
import { createHookContext } from "../src/kernel/hooks/create-context.js";
import { runAfterHooks } from "../src/kernel/hooks/executor.js";
import type { AfterHook } from "../src/kernel/hooks/types.js";
import type { PluginDb } from "../src/kernel/database/plugin-types.js";
import type { DrizzleDatabase } from "../src/kernel/database/drizzle-db.js";

/**
 * `inTransaction: true` buys ORDERING, not atomicity.
 *
 * It makes `runAfterHooks` run the hook inline before the commit and hand it a context carrying
 * `tx`. Until this card it did nothing to stop the hook writing through `context.db` — the plugin
 * db HANDLE — and on a two-connection driver such a write is not part of the transaction and
 * survives its rollback. A plugin author who marks a hook in-transaction and then reaches for the
 * obvious `context.db` got a silent rollback-surviving write, on a driver where nothing local
 * could show it.
 *
 * WHY NOT PGlite. Every other hook suite here runs on one PGlite instance, which hands the
 * transaction body the same `db` handle as everyone else. A handle write there rides the open
 * transaction anyway, so the rollback rows below pass whether or not the fix exists — the
 * instrument is blind to the defect by construction. `createTwoConnectionTestAdapter` is the
 * instrument that is not: transactions run on one connection, `adapter.db` is another.
 *
 * The two connections do not share data, unlike Neon's, so each row names WHICH connection it
 * expects the write on rather than reading one and calling it proof.
 */

const PROBE_TABLE = sql`probe_outbox`;

async function createProbeTable(db: DrizzleDatabase): Promise<void> {
  await db.execute(sql`create table if not exists probe_outbox (id text primary key)`);
}

async function probeRows(db: DrizzleDatabase): Promise<string[]> {
  const result = await db.execute(sql`select id from ${PROBE_TABLE} order by id`);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  return (rows as Array<{ id: string }>).map((row) => row.id);
}

describe("a hook marked in-transaction is handed the transaction, not the outside connection", () => {
  let harness: TwoConnectionTestAdapter;
  let kernel: ReturnType<typeof createKernel>;

  /** What each hook was handed, recorded at the moment it ran. */
  const seen: Array<{ name: string; txWasNull: boolean }> = [];
  let marker = "";

  /**
   * The obvious thing a plugin author writes. It reaches for `context.db` and nothing else —
   * that is the whole point: the kernel, not the hook's memory, has to make this land inside the
   * transaction.
   */
  const outboxWriter = async ({ context }: { context: HookContext }): Promise<void> => {
    seen.push({ name: "outbox", txWasNull: context.tx == null });
    await (context.db as unknown as DrizzleDatabase).execute(
      sql`insert into ${PROBE_TABLE} (id) values (${marker})`,
    );
  };

  const actor: Actor = {
    type: "user",
    userId: "intx-handle-1",
    email: "intx-handle@test.local",
    name: "In Transaction Handle",
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "admin",
    permissions: ["*:*"],
  };

  beforeAll(async () => {
    harness = await createTwoConnectionTestAdapter();
    await createProbeTable(harness.txDb);
    await createProbeTable(harness.outsideDb);

    /** The control: an unmarked hook must still reach the OUTSIDE connection, after the commit. */
    const externalEffect = async ({ context }: { context: HookContext }): Promise<void> => {
      seen.push({ name: "external", txWasNull: context.tx == null });
      await (context.db as unknown as DrizzleDatabase).execute(
        sql`insert into ${PROBE_TABLE} (id) values (${`${marker}-external`})`,
      );
    };

    const plugin = defineCommercePlugin({
      id: "in-transaction-handle-probe",
      version: "1.0.0",
      hooks: () => [
        { key: "catalog.afterCreate", handler: outboxWriter, inTransaction: true },
        { key: "catalog.afterCreate", handler: externalEffect },
      ],
    });

    const config = await createTestConfig({ databaseAdapter: harness.adapter, plugins: [plugin] });
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    seen.length = 0;
    marker = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await harness.txDb.execute(sql`truncate table ${PROBE_TABLE}`);
    await harness.outsideDb.execute(sql`truncate table ${PROBE_TABLE}`);
  });

  it("discards the marked hook's write when the transaction aborts, on BOTH connections", async () => {
    await expect(
      kernel.database.transaction(async (tx) => {
        const created = await kernel.services.catalog.create(
          { type: "product", slug: `intx-handle-abort-${marker}`, attributes: { locale: "en", title: "Aborted" } },
          actor,
          { tx, actor, requestId: "intx-handle-abort" },
        );
        expect(created.ok, "the create itself must succeed, or this row proves nothing").toBe(true);
        throw new Error("abort after the hook point");
      }),
    ).rejects.toThrow("abort after the hook point");

    // The positive control for this row: the hook DID run and DID have a transaction to write on.
    // Without it, "no row survived" is equally satisfied by a hook that never fired.
    expect(seen.find((s) => s.name === "outbox"), "the marked hook must have run").toBeDefined();
    expect(seen.find((s) => s.name === "outbox")!.txWasNull).toBe(false);

    // The defect, stated as the number it produces: the write lands on the outside connection,
    // where the rollback cannot reach it.
    expect(await probeRows(harness.outsideDb)).toEqual([]);
    expect(await probeRows(harness.txDb)).toEqual([]);
  });

  it("keeps the marked hook's write on the transaction's connection when it commits", async () => {
    await kernel.database.transaction(async (tx) => {
      const created = await kernel.services.catalog.create(
        { type: "product", slug: `intx-handle-commit-${marker}`, attributes: { locale: "en", title: "Committed" } },
        actor,
        { tx, actor, requestId: "intx-handle-commit" },
      );
      expect(created.ok).toBe(true);
    });

    // The twin of the row above. A fix that simply stopped the marked hook from writing at all
    // would satisfy "nothing survived the rollback"; nothing but the real fix satisfies both.
    expect(await probeRows(harness.txDb)).toEqual([marker]);

    // And the unmarked hook is unchanged: after the commit, on the outside connection, tx null.
    expect(await probeRows(harness.outsideDb)).toEqual([`${marker}-external`]);
    expect(seen.find((s) => s.name === "external")!.txWasNull).toBe(true);
  });

  it("still gives a marked hook a working db when the write is outside any transaction", async () => {
    // The null-tx case, and the reason the fix is `tx ?? db` rather than `tx`. `catalogHookContext`
    // sets `tx: isWriteContextTransactional(ctx) ? ctx.tx : null`, so a marked hook fired for a
    // write performed outside any transaction is handed `tx: null`. The catalog FACADE cannot
    // reach that state — `withMutationResult` opens its own transaction when given no ctx — so
    // this row drives `runAfterHooks` directly, which is the kernel unit that decides what a
    // marked hook's context carries.
    //
    // This row does NOT discriminate the fix: it is green before and after. Its job is to catch a
    // fix that removes `db` from a marked hook's context, which would silently stop every
    // non-transactional write from announcing itself — a worse failure than the one this card
    // closes.
    const context = createHookContext({
      actor,
      tx: null,
      logger: { info() {}, warn() {}, error() {} },
      services: {},
      db: harness.adapter.db as PluginDb,
      requestId: "intx-handle-notx",
    });

    const report = await runAfterHooks(
      [outboxWriter as unknown as AfterHook<unknown>],
      null,
      {},
      "create",
      context,
      () => true,
    );

    expect(report.hasErrors, `the marked hook must not fail: ${JSON.stringify(report.errors)}`).toBe(false);
    const outbox = seen.find((s) => s.name === "outbox");
    expect(outbox, "the marked hook must fire for a non-transactional write too").toBeDefined();
    expect(outbox!.txWasNull, "and it is handed tx: null").toBe(true);
    expect(await probeRows(harness.outsideDb)).toContain(marker);
  });
});
