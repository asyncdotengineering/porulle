/// <reference types="node" />
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./node_modules/@porulle/core/dist/auth/auth-schema.js",
    "./node_modules/@porulle/core/dist/kernel/database/schema.js",
    "./node_modules/@porulle/plugin-*/dist/**/schema.js",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
