import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // PGlite (WASM Postgres) is CPU/memory-heavy; under a full monorepo
    // `turbo run test` several PGlite suites run in parallel and contend for
    // resources, so individual tests need headroom (they finish in ~1-2s when
    // run alone). This package's files boot one or two FULL plugin apps per
    // beforeAll (schema push included), so hooks need more than @porulle/core's
    // 30s — oauth.test.ts boots two apps and sits at ~30s even alone.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Every test file in this package boots at least one full PGlite app in
    // beforeAll (some boot two); an uncapped fork-per-file pool starts 15+
    // WASM Postgres instances at once and setup hooks blow their timeout.
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
});
