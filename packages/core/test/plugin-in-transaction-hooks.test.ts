import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORG_ID } from "../src/auth/org.js";
import type { Actor } from "../src/auth/types.js";
import { defineCommercePlugin } from "../src/kernel/plugin/manifest.js";
import { createKernel } from "../src/runtime/kernel.js";
import { createPGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import type { PGliteTestAdapter } from "../src/test-utils/create-pglite-adapter.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

/**
 * 0.35.0 made after-commit the default for every after-hook and gave plugins no way to opt out,
 * which silently moved a transactional OUTBOX write — a row whose whole purpose is committing with
 * the write it records — to after the commit. These rows pin both sides of the opt-in that 0.35.1
 * adds, because only one of them can fail for the wrong reason: an unmarked hook that stops running
 * at all would also "not run inside the transaction".
 */
describe("plugin hooks can opt into running inside the transaction", () => {
  let adapter: PGliteTestAdapter;
  let cleanup: () => Promise<void>;
  let kernel: ReturnType<typeof createKernel>;

  const observed: Array<{ name: string; insideTransaction: boolean }> = [];

  const actor: Actor = {
    type: "user",
    userId: "plugin-intx-1",
    email: "plugin-intx@test.local",
    name: "Plugin In Transaction",
    vendorId: null,
    organizationId: DEFAULT_ORG_ID,
    role: "admin",
    permissions: ["*:*"],
  };

  beforeAll(async () => {
    const harness = await createPGliteTestAdapter();
    adapter = harness.adapter;
    cleanup = harness.cleanup;

    const outboxWriter = async (): Promise<void> => {
      observed.push({ name: "outbox", insideTransaction: adapter.inTransaction() });
    };
    const externalEffect = async (): Promise<void> => {
      observed.push({ name: "external", insideTransaction: adapter.inTransaction() });
    };

    const plugin = defineCommercePlugin({
      id: "in-transaction-probe",
      version: "1.0.0",
      hooks: () => [
        // The opt-in under test.
        { key: "catalog.afterCreate", handler: outboxWriter, inTransaction: true },
        // The control. Without it, "ran inside the transaction" could be satisfied by a build in
        // which EVERY hook is in-transaction — i.e. by reverting 0.35.0 entirely.
        { key: "catalog.afterCreate", handler: externalEffect },
      ],
    });

    const config = await createTestConfig({ databaseAdapter: adapter, plugins: [plugin] });
    kernel = createKernel(config);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("runs a marked hook inside the transaction and an unmarked one after it commits", async () => {
    observed.length = 0;

    await kernel.database.transaction(async (tx) => {
      await kernel.services.catalog.create(
        {
          type: "product",
          slug: `intx-${Date.now()}`,
          attributes: { locale: "en", title: "In transaction" },
        },
        actor,
        { tx, actor, requestId: "intx-1" },
      );
    });

    const outbox = observed.find((o) => o.name === "outbox");
    const external = observed.find((o) => o.name === "external");

    expect(outbox, "the marked hook must have run").toBeDefined();
    expect(external, "the unmarked hook must have run").toBeDefined();

    // The whole point: one inside, one after. Asserting only the first would pass against a build
    // where 0.35.0 was reverted and everything runs in-transaction again.
    expect(outbox!.insideTransaction).toBe(true);
    expect(external!.insideTransaction).toBe(false);
  });

  it("discards a marked hook's effect when the transaction aborts", async () => {
    observed.length = 0;

    await expect(
      kernel.database.transaction(async (tx) => {
        await kernel.services.catalog.create(
          {
            type: "product",
            slug: `intx-abort-${Date.now()}`,
            attributes: { locale: "en", title: "Aborted" },
          },
          actor,
          { tx, actor, requestId: "intx-2" },
        );
        throw new Error("abort after the hook point");
      }),
    ).rejects.toThrow("abort after the hook point");

    // The marked hook ran inside the doomed transaction, so anything it wrote is gone with it.
    // The unmarked hook never ran at all, which is what "after commit" means for a rollback.
    expect(observed.find((o) => o.name === "outbox")?.insideTransaction).toBe(true);
    expect(observed.find((o) => o.name === "external")).toBeUndefined();
  });
});
