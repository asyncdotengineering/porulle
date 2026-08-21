import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../../vitest.shared.js";

// Default config — hermetic only. Live-infra suites (e2e-full-flow,
// wishlist) live under explicit configs:
//   - bun run test:e2e          → vitest.e2e.config.ts (PG at localhost:5432)
//   - bun run test:e2e:wishlist → vitest.wishlist.config.ts (dev server)
// Excluding via this config keeps `bun run test` clean for CI/agents.
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      include: ["test/**/*.test.ts"],
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "test/e2e-full-flow.test.ts",
        "test/wishlist.test.ts",
      ],
      passWithNoTests: true,
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
