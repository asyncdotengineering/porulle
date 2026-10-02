import type { CommerceConfig } from "../config/types.js";
import { HookRegistry, isHookMarkedInTransaction, type HookHandler } from "../kernel/hooks/registry.js";
import { createDatabaseConnection } from "../kernel/database/adapter.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";
import { WebhookDeliveryWorker } from "../modules/webhooks/worker.js";
import { WebhooksRepository } from "../modules/webhooks/repository/index.js";
import { createConsoleLogger } from "../utils/logger.js";
import { withTiming } from "../kernel/service-timing.js";
import { setBootDefaultOrgId } from "../auth/org.js";
import { DrizzleJobsAdapter } from "../kernel/jobs/drizzle-adapter.js";
import type { ExecutionEngine } from "../kernel/jobs/adapter.js";
import { CompensationFailuresRepository } from "../kernel/compensation/repository.js";

import { KERNEL_SERVICE_FACTORIES } from "./kernel-modules.js";
import { registerConfiguredKernelHooks } from "./kernel-register-hooks.js";
import {
  assertKernelServicesReady,
  type Kernel,
  type WebhookDeliveryPayload,
} from "./kernel-types.js";

export type { Kernel, WebhookDeliveryPayload };
export type { ConfigRouteKernel, ConfigRouteDatabase } from "./kernel-types.js";

export function createKernel(config: CommerceConfig): Kernel {
  const hooks = new HookRegistry();
  const logger = createConsoleLogger("kernel");
  hooks.setLogger({ error: (obj, msg) => logger.error(msg, obj) });

  // Register the configured default organization for resolveOrgId(). Done here
  // rather than only in createCommerce so tests calling createKernel directly
  // see it too.
  if (config.auth?.defaultOrganizationId) {
    setBootDefaultOrgId(config.auth.defaultOrganizationId);
  }

  if (!config.storage) {
    throw new Error(
      "Storage adapter is required. Configure `storage` in defineConfig (for example: localStorageAdapter for development, or s3StorageAdapter/r2StorageAdapter for object storage).",
    );
  }

  const database = createDatabaseConnection({
    adapter: config.databaseAdapter ?? {
      provider: config.database.provider,
      db: {},
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn({});
      },
    },
  });
  const services: Partial<Kernel["services"]> = {
    email: config.email,
  };

  const serviceContainer = services as Record<string, unknown>;
  serviceContainer.database = database;

  const db = database.db as DrizzleDatabase;

  const jobsTaskMap = new Map(
    (config.jobs?.tasks ?? []).map((t) => [t.slug, t]),
  );
  const jobsEngine: ExecutionEngine =
    config.jobs?.adapter ?? new DrizzleJobsAdapter(db);
  jobsEngine.register({
    tasks: jobsTaskMap,
    context: { logger, db, services: serviceContainer },
    ...(config.jobs?.processingOrder !== undefined
      ? { processingOrder: config.jobs.processingOrder }
      : {}),
  });
  serviceContainer.jobs = jobsEngine;

  for (const [id, create] of KERNEL_SERVICE_FACTORIES) {
    serviceContainer[id] = create({ database, db, hooks, config, services: serviceContainer });
  }

  const baseWebhooks = services.webhooks!;
  const webhookWorker = new WebhookDeliveryWorker({
    repository: new WebhooksRepository(db),
  });
  services.webhooks = Object.assign(baseWebhooks, {
    async enqueueDelivery(payload: WebhookDeliveryPayload) {
      await webhookWorker.deliver(payload);
    },
  });

  services.compensationFailures = new CompensationFailuresRepository(db);

  assertKernelServicesReady(services);

  if (process.env.NODE_ENV !== "test") {
    const timedLogger = {
      info: (obj: Record<string, unknown>, msg: string) => logger.info(msg, obj),
      error: (obj: Record<string, unknown>, msg: string) => logger.error(msg, obj),
    };
    const serviceKeys = Object.keys(services) as Array<keyof typeof services>;
    for (const key of serviceKeys) {
      const svc = services[key];
      if (svc && typeof svc === "object" && key !== "email") {
        (services as Record<string, unknown>)[key] = withTiming(
          svc as object,
          key,
          timedLogger,
        );
      }
    }
  }

  registerConfiguredKernelHooks(config, hooks);

  const kernel: Kernel = {
    config,
    hooks,
    database,
    services,
    pluginPermissions: [...(config.pluginPermissions ?? [])],
    logger,
  };

  for (const [key, handlers] of Object.entries(config.hooks ?? {})) {
    for (const handler of handlers) {
      // A plugin that declared `inTransaction` gets appendInTransaction, so its hook runs inside
      // the writing transaction rather than in the after-commit drain. Everything else defaults to
      // after-commit, which is what 0.35.0 established.
      if (isHookMarkedInTransaction(handler)) {
        hooks.appendInTransaction(key, handler as HookHandler);
      } else {
        hooks.append(key, handler as HookHandler);
      }
    }
  }

  for (const model of config.analytics?.models ?? []) {
    services.analytics.registerModel(model);
  }

  return kernel;
}
