import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./node_modules/@porulle/core/src/**/schema.ts",
    "./node_modules/@porulle/core/src/auth/auth-schema.ts",
    "./node_modules/@porulle/plugin-pos/src/schema.ts",
    "./node_modules/@porulle/plugin-pos-restaurant/src/schema.ts",
    "./node_modules/@porulle/plugin-uom/src/schema.ts",
    "./node_modules/@porulle/plugin-procurement/src/schema.ts",
    "./node_modules/@porulle/plugin-warehouse/src/schema.ts",
    "./node_modules/@porulle/plugin-production/src/schema.ts",
    "./node_modules/@porulle/plugin-notifications/src/schema.ts",
    "./node_modules/@porulle/plugin-scheduled-orders/src/schema.ts",
    "./node_modules/@porulle/plugin-reviews/src/schema.ts",
  ],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/uc_restaurant",
  },
});
