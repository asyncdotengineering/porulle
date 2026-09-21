/**
 * A hook that is slow but succeeds is invisible today: the only instrument is a 20 s timeout, and
 * by the time it fires the cost is spent. `failures.ts` records the case this exists to surface —
 * four connector suites at 578.23 s instead of 27.29 s, 51 `deliverWebhooks timed out` lines, exit
 * 0 and every test passing.
 */
import { describe, expect, it } from "vitest";
import { runAfterHooks } from "../src/kernel/hooks/executor.js";
import type { HookContext } from "../src/kernel/hooks/types.js";

function contextWithCapturedLogs() {
  const warnings: Array<{ message: string; data?: unknown }> = [];
  const context = {
    actor: null,
    tx: null,
    logger: {
      info: () => undefined,
      warn: (message: string, data?: unknown) => { warnings.push({ message, data }); },
      error: () => undefined,
    },
    services: {},
    context: {},
    requestId: "slow-hook-test",
    origin: "update",
    jobs: {},
    db: {},
  } as unknown as HookContext;
  return { context, warnings };
}

describe("slow after-hooks are surfaced before they time out", () => {
  it("warns above 100ms and names the transaction cost for an in-transaction hook", async () => {
    const { context, warnings } = contextWithCapturedLogs();
    const slowHook = async function slowInTransactionHook() {
      await new Promise((resolve) => setTimeout(resolve, 140));
    };

    const report = await runAfterHooks([slowHook], null, {}, "update", context, () => true);

    expect(report.hasErrors, "a slow hook succeeded; it must not be reported as failed").toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/slowInTransactionHook.*took \d+ms/);
    expect(warnings[0]!.data).toMatchObject({ inTransaction: true });
    expect(String((warnings[0]!.data as { hint: string }).hint)).toContain("holds its connection");
  });

  it("stays silent under the threshold", async () => {
    const { context, warnings } = contextWithCapturedLogs();
    const fastHook = async function fastHook() { /* returns immediately */ };

    await runAfterHooks([fastHook], null, {}, "update", context, () => true);

    expect(warnings, "a fast hook must not warn, or the signal is worthless").toHaveLength(0);
  });
});
