import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../../../vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      environment: "node",
      // Plugin-appointments has 8 tables; createPluginTestApp's PGlite push
      // takes 15–25s under contention. Default 10s hookTimeout is too aggressive.
      hookTimeout: 60_000,
      testTimeout: 30_000,
    },
  }),
);
