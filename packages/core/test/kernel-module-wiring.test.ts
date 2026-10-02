import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import { KERNEL_SERVICE_FACTORIES } from "../src/runtime/kernel-modules.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

describe("kernel service wiring", () => {
  let cleanup: () => Promise<void>;
  let kernel: ReturnType<typeof createKernel>;

  beforeAll(async () => {
    const out = await createPGliteTestConfig({});
    cleanup = out.cleanup;
    // Boots only if every factory runs after the services it reads at
    // construction (catalog's repository, the inventory service).
    kernel = createKernel(out.config);
  });

  afterAll(async () => {
    await cleanup();
  });

  it("builds every core service", () => {
    expect(KERNEL_SERVICE_FACTORIES).toHaveLength(19);
    for (const [id] of KERNEL_SERVICE_FACTORIES) {
      expect((kernel.services as Record<string, unknown>)[id]).toBeDefined();
    }
  });

  it("also exposes compensationFailures and email", () => {
    expect(kernel.services.compensationFailures).toBeDefined();
    expect(kernel.services.email).toBeDefined();
  });
});
