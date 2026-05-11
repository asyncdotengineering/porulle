/// <reference types="node" />
import { defineConfig } from "drizzle-kit";

/**
 * Combined Drizzle config for deploying all schemas (core + plugins + app).
 * Used for Neon/production database provisioning.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./packages/core/src/**/schema.ts",
    "./packages/core/src/auth/auth-schema.ts",
    "./packages/plugins/*/src/schema.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
