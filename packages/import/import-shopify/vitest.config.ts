import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../../../vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      environment: "node",
      // Same long-running concerns as import-woocommerce.
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
