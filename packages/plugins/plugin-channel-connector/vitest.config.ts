import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // PGlite (WASM Postgres) is CPU/memory-heavy; under a full monorepo
    // `turbo run test` several PGlite suites run in parallel and contend for
    // resources, so individual tests need headroom (they finish in ~1-2s when
    // run alone). Same rationale as @porulle/core's config.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
