import { defineConfig } from "vitest/config";

// Wishlist E2E config — runs against a live dev server at API_URL
// (default http://localhost:4000) using STORE_API_KEY. Start the server
// with `bun run dev` and provision an API key first.
export default defineConfig({
  test: {
    include: ["test/wishlist.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
