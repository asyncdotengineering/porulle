import { describe, expect, it } from "vitest";
import { createTestKernel } from "../src/test-utils/create-test-kernel.js";

describe("plugin test utilities", () => {

  it("boots a minimal kernel with createTestKernel", async () => {
    const kernel = await createTestKernel();
    const health = await kernel.services.catalog.list({ pagination: { page: 1, limit: 5 } }, null);
    expect(health.ok).toBe(true);
  });
});
