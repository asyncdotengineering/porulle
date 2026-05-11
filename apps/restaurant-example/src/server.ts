import { serve } from "@hono/node-server";
import { createServer } from "@porulle/core";

const configOrPromise = (await import("../commerce.config.js")).default;
const config = configOrPromise instanceof Promise ? await configOrPromise : configOrPromise;
const { app, kernel, logger } = await createServer(config);

const port = Number(process.env.PORT ?? 4002);
serve({ fetch: app.fetch, port }, () => {
  logger.info(`The Blue Apron Bistro POS running on http://localhost:${port}`);
  logger.info(`  REST API: http://localhost:${port}/api`);
  logger.info(`  POS:      http://localhost:${port}/api/pos`);
});
