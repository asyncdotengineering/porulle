import { serve } from "@hono/node-server";
import { createServer } from "@porulle/core";

const configOrPromise = (await import("../commerce.config.js")).default;
const config = configOrPromise instanceof Promise ? await configOrPromise : configOrPromise;
const { app, kernel, logger } = await createServer(config);

const port = Number(process.env.PORT ?? 4003);
serve({ fetch: app.fetch, port }, () => {
  logger.info(`Tea Avenue running on http://localhost:${port}`);
  logger.info(`  11 plugins loaded`);
  logger.info(`  REST API: http://localhost:${port}/api`);
});
