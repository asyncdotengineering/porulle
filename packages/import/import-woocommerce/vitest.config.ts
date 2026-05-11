import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // createTestKernel + full import flow (catalog/customers/variants) takes
    // 10-25s under PGlite cold-start. Default 5s test timeout is too aggressive.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
