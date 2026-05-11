import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Same long-running concerns as import-woocommerce.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
