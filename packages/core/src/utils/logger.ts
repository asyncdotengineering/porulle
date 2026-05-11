import type { Logger } from "../kernel/hooks/types.js";

export function createLogger(scope: string): Logger {
  return {
    info(message: string, data?: unknown) {
      // eslint-disable-next-line no-console
      console.info(`[${scope}] ${message}`, data ?? "");
    },
    warn(message: string, data?: unknown) {
      // eslint-disable-next-line no-console
      console.warn(`[${scope}] ${message}`, data ?? "");
    },
    error(message: string, data?: unknown) {
      // eslint-disable-next-line no-console
      console.error(`[${scope}] ${message}`, data ?? "");
    },
  };
}
