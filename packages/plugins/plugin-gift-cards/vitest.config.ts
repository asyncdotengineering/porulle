import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../../../vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      globals: false,
      environment: "node",
      include: ["test/**/*.test.ts"],
    },
  }),
);
