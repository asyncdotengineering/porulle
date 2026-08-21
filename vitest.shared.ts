import { defineConfig } from "vitest/config";

/**
 * Shared test defaults for every package in the monorepo.
 *
 * Parallelism here is a product, not a sum: `turbo run test` runs several
 * packages at once and each package's vitest forks its own pool, so the machine
 * sees (turbo concurrency x maxForks) processes. Most suites in this repo boot
 * PGlite — an in-process WASM Postgres — so a fork is not a cheap worker; it
 * holds a whole database and pushes a schema before its first test runs.
 *
 * Uncapped, vitest defaults maxForks to roughly the core count, and turbo
 * defaults its concurrency to 10. On an 8-core machine that is ~70 processes,
 * each wanting a core. Nothing fails outright: everything runs several times
 * slower and the contention lasts minutes instead of seconds.
 *
 * The cap belongs here rather than in each package, because a new package
 * inherits it instead of rediscovering the problem as a hook timeout. The
 * matching turbo concurrency is pinned in the root scripts — `test`, and also
 * `build`, `check-types` and `lint`, which spawn a `tsc` per package and
 * oversubscribe just as badly without forking anything. Change one and
 * reconsider the others, since only the product matters.
 */
/**
 * Raise this when running one package on its own, where nothing else is
 * competing for cores: `VITEST_MAX_FORKS=8 pnpm --filter @porulle/core test`.
 * The default protects a full `turbo run test`, which is when the product
 * actually bites.
 */
const maxForks = Number(process.env.VITEST_MAX_FORKS ?? 4);

export const sharedTestConfig = defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: {
        maxForks,
      },
    },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
