import { describe, expect, it } from "vitest";
import { isNodeRuntime } from "../src/runtime/server.js";

/**
 * S2-04 / LB-6: `process.on(...)` registrations must be guarded by a runtime
 * check so edge runtimes (Cloudflare Workers, Vercel Edge — where `process`
 * is undefined or partial) don't throw at server boot.
 *
 * The full createServer() bootstraps drizzle-kit (for schema push) which
 * itself touches `process.stdin` etc. — so a coarse "stub the whole process
 * object" test crashes on imports unrelated to the guard. We test the
 * exported `isNodeRuntime()` helper directly: it's the single conditional
 * that determines whether `process.on(unhandledRejection|uncaughtException)`
 * gets registered. If this helper returns false, server.ts skips registration.
 */
describe("isNodeRuntime — S2-04 edge-runtime guard", () => {
  it("returns true under standard Node/Bun (the test environment)", () => {
    expect(isNodeRuntime()).toBe(true);
  });

  it("returns false when process is undefined", () => {
    const prev = globalThis.process;
    try {
      (globalThis as unknown as { process: undefined }).process = undefined;
      expect(isNodeRuntime()).toBe(false);
    } finally {
      globalThis.process = prev;
    }
  });

  it("returns false when process.on is missing", () => {
    const prev = globalThis.process;
    try {
      (globalThis as unknown as { process: { env: Record<string, string> } }).process = {
        env: { ...(prev.env as Record<string, string>) },
      };
      expect(isNodeRuntime()).toBe(false);
    } finally {
      globalThis.process = prev;
    }
  });

  it("returns false when process.exit is missing", () => {
    const prev = globalThis.process;
    try {
      (globalThis as unknown as { process: { env: Record<string, string>; on: () => void } }).process = {
        env: { ...(prev.env as Record<string, string>) },
        on: () => {},
      };
      expect(isNodeRuntime()).toBe(false);
    } finally {
      globalThis.process = prev;
    }
  });
});
