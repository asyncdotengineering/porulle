import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "@porulle/core";
import configPromise from "../commerce.config.js";

const PORT = Number(process.env.PORT ?? 4000);

const config = await configPromise;
const { app, logger } = await createServer(config);

// ─── Serve uploaded media files ────────────────────────────────────
app.use(
  "/assets/*",
  serveStatic({
    root: "./.data/media",
    rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
  }),
);

// ─── Health check ────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok", store: config.storeName }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logger.info({
    store: config.storeName,
    port: info.port,
    restApi: `http://localhost:${info.port}/api`,
    mcp: `http://localhost:${info.port}/mcp`,
    health: `http://localhost:${info.port}/api/health`,
  }, "server started");
});
