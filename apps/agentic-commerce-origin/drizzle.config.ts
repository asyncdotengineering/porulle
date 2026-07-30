import { defineConfig } from "drizzle-kit";
import { getSchemaFiles } from "@porulle/core";

export default defineConfig({
  dialect: "postgresql",
  schema: getSchemaFiles(),
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/kuralle_agentic_commerce" },
});
