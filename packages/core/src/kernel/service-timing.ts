/**
 * Service method observability via ES Proxy.
 *
 * Wraps a service object so that every async method call is timed.
 * Slow calls (above threshold) are logged with service name, method name,
 * and duration. Failed calls always log with the error.
 *
 * Usage at kernel boot:
 *   services.inventory = withTiming(inventoryService, "inventory", logger);
 *   services.catalog = withTiming(catalogService, "catalog", logger);
 *
 * Produces log entries like:
 *   { service: "inventory", method: "adjust", durationMs: 245 } "slow service call"
 *   { service: "catalog", method: "create", durationMs: 12, err: ... } "service call failed"
 *
 * Only wraps own methods (not inherited). Synchronous property access
 * (e.g., reading a field) passes through unchanged with zero overhead.
 */

interface TimingLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export function withTiming<T extends object>(
  service: T,
  serviceName: string,
  logger: TimingLogger,
  slowThresholdMs = 100,
): T {
  return new Proxy(service, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Only wrap functions, skip symbols and non-function props
      if (typeof value !== "function" || typeof prop === "symbol") {
        return value;
      }

      // Skip internal/private-looking methods
      const methodName = String(prop);
      if (methodName.startsWith("_")) return value;

      return function proxiedMethod(this: unknown, ...args: unknown[]) {
        const start = performance.now();

        // Call the original method
        let result: unknown;
        try {
          result = value.apply(target, args);
        } catch (err) {
          // Synchronous throw
          const durationMs = Math.round(performance.now() - start);
          logger.error(
            { service: serviceName, method: methodName, durationMs, err },
            `${serviceName}.${methodName} failed (${durationMs}ms)`,
          );
          throw err;
        }

        // If result is a promise, attach timing to its resolution
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (resolved) => {
              const durationMs = Math.round(performance.now() - start);
              if (durationMs > slowThresholdMs) {
                logger.info(
                  { service: serviceName, method: methodName, durationMs },
                  `${serviceName}.${methodName} slow (${durationMs}ms)`,
                );
              }
              return resolved;
            },
            (err) => {
              const durationMs = Math.round(performance.now() - start);
              logger.error(
                { service: serviceName, method: methodName, durationMs, err },
                `${serviceName}.${methodName} failed (${durationMs}ms)`,
              );
              throw err;
            },
          );
        }

        return result;
      };
    },
  });
}
