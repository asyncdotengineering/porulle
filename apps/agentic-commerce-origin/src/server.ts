import { serve } from "@hono/node-server";
import { postgresAdapter } from "@porulle/adapter-postgres";
import { createServer } from "@porulle/core";
import { createOriginConfig } from "../commerce.config.js";

const databaseUrl = process.env.DATABASE_URL ?? "postgresql://localhost:5432/kuralle_agentic_commerce";
const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:4000";
const config = await createOriginConfig({
  DATABASE_URL: databaseUrl,
  PUBLIC_URL: publicUrl,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY ?? "",
  ...(process.env.STRIPE_WEBHOOK_SECRET ? { STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET } : {}),
}, postgresAdapter({ connectionString: databaseUrl }));
const { app, logger } = await createServer(config);
const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port }, () => logger.info(`Agentic commerce origin listening on ${publicUrl}`));
