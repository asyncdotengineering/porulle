import type { Logger } from "./logger.js";

/**
 * Sets up graceful shutdown handlers for SIGTERM and SIGINT.
 *
 * On signal:
 * 1. Stops accepting new connections
 * 2. Runs cleanup (close DB pool, flush logs)
 * 3. Force-exits after timeout if cleanup hangs
 */
export function setupGracefulShutdown(opts: {
  cleanup: () => Promise<void>;
  logger: Logger;
  timeoutMs?: number;
}): void {
  const { cleanup, logger, timeoutMs = 30_000 } = opts;
  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info({ signal }, "shutdown signal received, draining connections");

    const forceTimer = setTimeout(() => {
      logger.error("shutdown timeout exceeded, forcing exit");
      process.exit(1);
    }, timeoutMs);
    forceTimer.unref();

    try {
      await cleanup();
      logger.info("graceful shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
