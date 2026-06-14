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
    // PGlite (WASM Postgres) is CPU/memory-heavy; under a full monorepo
    // `turbo run test` several PGlite suites run in parallel and contend for
    // resources, so individual tests need headroom (they finish in ~1-2s when
    // run alone). Match the body timeout closer to the schema-push hook.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
