import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../../../vitest.shared.js";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      // Every test file here boots at least one full PGlite app in beforeAll
      // and some boot two, so the schema push alone outlasts the shared
      // 30s budget — oauth.test.ts sits near it even running alone.
      hookTimeout: 60_000,
    },
  }),
);
