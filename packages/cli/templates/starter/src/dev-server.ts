import configPromise from "../commerce.config.js";
import { createServer } from "@porulle/core";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

const PORT = Number(process.env.PORT ?? 4000);

const config = await configPromise;
const { app, logger } = await createServer(config);
app.use("/assets/*", serveStatic({ root: "./.data/media" }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info(
    {
      store: config.storeName,
      port: info.port,
      health: `http://localhost:${info.port}/api/health`,
    },
    "UnifiedCommerce starter running",
  );
});
