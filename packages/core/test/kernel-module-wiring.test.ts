import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/runtime/kernel.js";
import {
  KERNEL_ALL_MODULES,
  kernelModuleInstantiationOrder,
} from "../src/runtime/kernel-modules.js";
import { createPGliteTestConfig } from "../src/test-utils/create-test-config.js";

describe("kernel module wiring (S4-06)", () => {
  it("topo order satisfies catalog before inventory and catalog before pricing", () => {
    const order = kernelModuleInstantiationOrder();
    const ic = order.indexOf("catalog");
    const ii = order.indexOf("inventory");
    const ip = order.indexOf("pricing");
    expect(ic).toBeGreaterThanOrEqual(0);
    expect(ii).toBeGreaterThanOrEqual(0);
    expect(ip).toBeGreaterThanOrEqual(0);
    expect(ic).toBeLessThan(ii);
    expect(ic).toBeLessThan(ip);
  });

  describe("createKernel", () => {
    let cleanup: () => Promise<void>;
    let kernel: ReturnType<typeof createKernel>;

    beforeAll(async () => {
      const out = await createPGliteTestConfig({});
      cleanup = out.cleanup;
      kernel = createKernel(out.config);
    });

    afterAll(async () => {
      await cleanup();
    });

    it("instantiates all 17 module registry services", () => {
      const ids = Object.keys(KERNEL_ALL_MODULES);
      expect(ids).toHaveLength(17);
      for (const id of ids) {
        expect(
          (kernel.services as Record<string, unknown>)[id],
        ).toBeDefined();
      }
    });

    it("also exposes compensationFailures and email", () => {
      expect(kernel.services.compensationFailures).toBeDefined();
      expect(kernel.services.email).toBeDefined();
    });
  });
});
