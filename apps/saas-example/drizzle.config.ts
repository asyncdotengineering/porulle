import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "../../packages/core/src/kernel/database/schema.ts",
    "../../packages/plugins/*/src/schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/saas_example",
  },
});
