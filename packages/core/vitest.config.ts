import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../../vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      setupFiles: ["./test/setup.ts"],
      include: ["test/**/*.test.ts"],
      passWithNoTests: true,
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
      },
    },
  }),
);
