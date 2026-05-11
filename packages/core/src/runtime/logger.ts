import pino from "pino";
import type { CommerceConfig } from "../config/types.js";

export type Logger = pino.Logger;

/**
 * Create a structured JSON logger for the commerce engine.
 *
 * Automatically redacts sensitive fields (authorization, password, token, etc.)
 * from all log output. Uses Pino for high-performance, newline-delimited JSON.
 */
export function createLogger(config: CommerceConfig): Logger {
  return pino({
    level: config.logLevel ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.secret",
        "*.apiKey",
        "*.creditCard",
        "*.token",
        "*.apiToken",
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      req: pino.stdSerializers.req,
      err: pino.stdSerializers.err,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
