/// <reference types="node" />
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./packages/core/src/kernel/database/schema.ts",
    "./packages/plugins/*/src/schema.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? "postgres://localhost:5432/unified_commerce",
  },
});
