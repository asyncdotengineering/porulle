import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "@porulle/core";
import configPromise from "../commerce.config.js";

const PORT = Number(process.env.PORT ?? 4001);

const config = await configPromise;
const { app, logger } = await createServer(config);

app.use(
  "/assets/*",
  serveStatic({
    root: "./.data/media",
    rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
  }),
);

app.get("/health", (c) =>
  c.json({ status: "ok", platform: "UnifiedCommerce SaaS Example" }),
);

serve({ fetch: app.fetch, port: PORT }, () => {
  logger.info(`SaaS Example running at http://localhost:${PORT}`);
  logger.info("API docs: http://localhost:" + PORT + "/api/reference");
});
