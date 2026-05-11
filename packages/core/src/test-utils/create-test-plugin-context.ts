import { HookRegistry } from "../kernel/hooks/registry.js";
import { createLogger } from "../utils/logger.js";
import { createTestConfig } from "./create-test-config.js";
import type { CommerceConfig } from "../config/types.js";

interface PluginContextShape {
  hooks: HookRegistry;
  config: CommerceConfig;
  services: Record<string, unknown>;
  routes: { add(method: string, path: string, handler: (...args: unknown[]) => unknown): void };
  analytics: { registerModel(model: unknown): void };
  database: {
    registerSchema(schema: Record<string, unknown>): void;
    query: unknown;
    transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
  };
  logger: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void; error(message: string, data?: unknown): void };
}

export interface TestPluginContext extends PluginContextShape {
  registeredRoutes: Array<{ method: string; path: string; handler: (...args: unknown[]) => unknown }>;
  registeredAnalyticsModels: unknown[];
  registeredSchemas: Array<Record<string, unknown>>;
}

export async function createTestPluginContext(options?: {
  config?: Partial<CommerceConfig>;
  services?: Record<string, unknown>;
}): Promise<TestPluginContext> {
  const hooks = new HookRegistry();
  const config = await createTestConfig(options?.config ?? {});
  const services = options?.services ?? {};

  const registeredRoutes: TestPluginContext["registeredRoutes"] = [];
  const registeredAnalyticsModels: unknown[] = [];
  const registeredSchemas: Array<Record<string, unknown>> = [];

  return {
    hooks,
    config,
    services,
    routes: {
      add(method, path, handler) {
        registeredRoutes.push({ method: method.toUpperCase(), path, handler });
      },
    },
    analytics: {
      registerModel(model) {
        registeredAnalyticsModels.push(model);
      },
    },
    database: {
      registerSchema(schema) {
        registeredSchemas.push(schema);
      },
      query: {},
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn({});
      },
    },
    logger: createLogger("test-plugin-context"),
    registeredRoutes,
    registeredAnalyticsModels,
    registeredSchemas,
  };
}
