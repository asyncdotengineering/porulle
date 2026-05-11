import { defineConfig } from "vitest/config";

// E2E config — runs the full-flow suite against a live PostgreSQL.
// Prereqs: `bun run db:reset` (creates DB + pushes schema) and core built
// (`cd packages/core && bun run build`). See test/e2e-full-flow.test.ts.
export default defineConfig({
  test: {
    include: ["test/e2e-full-flow.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
