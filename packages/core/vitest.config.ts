import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    // Use forks pool for isolated PGlite instances per test file
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false, // Parallel file execution
      },
    },
    // PGlite schema push can take ~1-2s on first run
    hookTimeout: 30_000,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
