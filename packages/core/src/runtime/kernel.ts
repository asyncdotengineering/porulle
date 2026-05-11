import type { CommerceConfig } from "../config/types.js";
import { HookRegistry, type HookHandler } from "../kernel/hooks/registry.js";
import { createDatabaseConnection } from "../kernel/database/adapter.js";
import type { DrizzleDatabase } from "../kernel/database/drizzle-db.js";
import type { AppModule } from "../kernel/module/index.js";
import { topoSortModules } from "../kernel/module/index.js";
import { WebhookDeliveryWorker } from "../modules/webhooks/worker.js";
import { WebhooksRepository } from "../modules/webhooks/repository/index.js";
import { createLogger } from "../utils/logger.js";
import { withTiming } from "../kernel/service-timing.js";
import { setBootDefaultOrgId } from "../auth/org.js";
import { setBootStrictOrgResolution } from "../auth/strict-org-resolution.js";
import { DrizzleJobsAdapter } from "../kernel/jobs/drizzle-adapter.js";
import { CompensationFailuresRepository } from "../kernel/compensation/repository.js";

import {
  KERNEL_ALL_MODULES,
  kernelModulesForTopoSort,
} from "./kernel-modules.js";
import { registerConfiguredKernelHooks } from "./kernel-register-hooks.js";
import {
  assertKernelServicesReady,
  assertSortedBefore,
  type Kernel,
  type WebhookDeliveryPayload,
} from "./kernel-types.js";

export type { Kernel, WebhookDeliveryPayload };
export {
  KERNEL_ALL_MODULES,
  kernelModuleInstantiationOrder,
} from "./kernel-modules.js";

export function createKernel(config: CommerceConfig): Kernel {
  const hooks = new HookRegistry();
  const logger = createLogger("kernel");
  hooks.setLogger({ error: (obj, msg) => logger.error(msg, obj) });

  // Apply boot-time org resolution settings from config. Previously only
  // createCommerce did this, which meant tests calling createKernel directly
  // had services fall back to DEFAULT_ORG_ID with a deprecation warning even
  // when config.auth.defaultOrganizationId was set.
  setBootStrictOrgResolution(config.auth?.strictOrgResolution === true);
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
  const jobsAdapter = new DrizzleJobsAdapter(db, jobsTaskMap);
  serviceContainer.jobs = jobsAdapter;

  const topoGraph = kernelModulesForTopoSort();
  const order = topoSortModules(topoGraph);
  const moduleKeys = Object.keys(KERNEL_ALL_MODULES);
  if (order.length !== moduleKeys.length) {
    throw new Error(
      `topoSortModules length mismatch: got ${order.length}, expected ${moduleKeys.length}`,
    );
  }
  assertSortedBefore(order, "catalog", "inventory");
  assertSortedBefore(order, "catalog", "pricing");

  const moduleDeps = {
    db: database,
    hooks,
    config,
    logger,
  };

  for (const id of order) {
    const mod = KERNEL_ALL_MODULES[id as keyof typeof KERNEL_ALL_MODULES];
    const svc = (mod as AppModule<unknown, unknown, Record<string, unknown>>).service({
      ...moduleDeps,
      services: services as Record<string, unknown>,
    });
    (services as Record<string, unknown>)[id] = svc;
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
      hooks.append(key, handler as HookHandler);
    }
  }

  for (const model of config.analytics?.models ?? []) {
    services.analytics.registerModel(model);
  }

  return kernel;
}
