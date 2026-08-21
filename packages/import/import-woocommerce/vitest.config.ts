import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../../../vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      environment: "node",
      // createTestKernel + full import flow (catalog/customers/variants) takes
      // 10-25s under PGlite cold-start. Default 5s test timeout is too aggressive.
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
