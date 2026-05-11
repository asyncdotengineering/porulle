import { describe, expect, it, vi } from "vitest";
import { HookRegistry } from "../src/kernel/hooks/registry.js";
import { runAfterHooks, runBeforeHooks } from "../src/kernel/hooks/executor.js";
import type { HookContext } from "../src/kernel/hooks/types.js";
import type { PluginDb } from "../src/kernel/database/plugin-types.js";
import { NullJobsAdapter } from "../src/kernel/jobs/adapter.js";

describe("HookRegistry", () => {
  it("orders hooks as prepend, config, append", () => {
    const registry = new HookRegistry();
    const calls: string[] = [];

    const prepend = () => calls.push("prepend");
    const config = () => calls.push("config");
    const append = () => calls.push("append");

    registry.prepend("catalog.beforeCreate", prepend);
    registry.registerConfigHooks("catalog.beforeCreate", [config]);
    registry.append("catalog.beforeCreate", append);

    const hooks = registry.resolve("catalog.beforeCreate");
    hooks.forEach((hook) => hook());

    expect(calls).toEqual(["prepend", "config", "append"]);
  });
});

describe("hook executor", () => {
  const mockDb = { execute: vi.fn() } as unknown as PluginDb;
  const context: HookContext = {
    actor: null,
    tx: null,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    services: {},
    context: {},
    requestId: "test",
    origin: "rest",
    jobs: new NullJobsAdapter(),
    db: mockDb,
  };

  it("transforms before-hook data sequentially", async () => {
    const output = await runBeforeHooks(
      [
        async ({ data }) => data + 1,
        async ({ data }) => data * 2,
      ],
      2,
      "create",
      context,
    );

    expect(output).toBe(6);
  });

  it("aborts before-hook chain on throw", async () => {
    await expect(
      runBeforeHooks(
        [
          async () => {
            throw new Error("abort");
          },
        ],
        { a: 1 },
        "create",
        context,
      ),
    ).rejects.toThrow("abort");
  });

  it("captures after-hook errors without throwing", async () => {
    const report = await runAfterHooks(
      [
        async () => {
          throw new Error("after failed");
        },
      ],
      null,
      { id: "1" },
      "create",
      context,
    );

    expect(report.hasErrors).toBe(true);
    expect(report.errors[0]?.message).toContain("after failed");
  });
});
