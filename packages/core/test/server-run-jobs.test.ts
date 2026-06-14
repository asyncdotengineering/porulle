/**
 * server.runJobs() (#15)
 *
 * createServer exposes a public runJobs() that triggers one job-runner tick,
 * so Workers can drive the queue from scheduled() instead of an in-process
 * setInterval (which can't outlive a request on Workers).
 */

import { describe, it, expect } from "vitest";
import { createServer } from "../src/runtime/server.js";
import { createTestConfig } from "../src/test-utils/create-test-config.js";

describe("server.runJobs() (#15)", () => {
  it("exposes a callable cron tick returning a processed/failed summary", async () => {
    const server = await createServer(await createTestConfig());
    expect(typeof server.runJobs).toBe("function");

    const result = await server.runJobs();
    expect(result).toEqual({
      processed: expect.any(Number),
      failed: expect.any(Number),
    });
  });
});
