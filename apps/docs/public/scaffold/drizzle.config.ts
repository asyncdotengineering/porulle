/// <reference types="node" />
// Only needed for the PRODUCTION Postgres path (adapter-postgres). With the
// default PGlite adapter, the schema is pushed automatically on boot — you do
// not need drizzle-kit at all. When you switch to Postgres, run:
//   pnpm drizzle-kit push --config drizzle.config.ts
import { getSchemaFiles } from "@porulle/core";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: getSchemaFiles(),
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/my_porulle_store",
  },
});
