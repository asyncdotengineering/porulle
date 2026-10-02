import { randomUUID } from "node:crypto";
import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
import type { JobsAdapter } from "../jobs/adapter.js";
import { NullJobsAdapter } from "../jobs/adapter.js";
import type { PluginDb } from "../database/plugin-types.js";
import type { HookContext, HookOrigin, Logger, ServiceContainer } from "./types.js";
import { createConsoleLogger } from "../../utils/logger.js";

export interface CreateHookContextArgs {
  actor: Actor | null;
  tx?: unknown;
  logger: Logger;
  services: ServiceContainer;
  context?: Record<string, unknown>;
  requestId?: string;
  origin?: HookOrigin;
  jobs?: JobsAdapter;
  db?: PluginDb;
  /** Prefer this over {@link CreateHookContextArgs.kernel}. */
  database?: { db: PluginDb };
  /**
   * @deprecated Pass {@link CreateHookContextArgs.database} or {@link CreateHookContextArgs.db} instead.
   */
  kernel?: { database: { db: PluginDb } };
  commerceConfig?: CommerceConfig | null;
}

const nullJobs = new NullJobsAdapter();

/**
 * Creates a HookContext with sensible defaults.
 */
export function createHookContext(args: CreateHookContextArgs): HookContext {
  const db =
    args.db ?? args.database?.db ?? args.kernel?.database?.db ?? null;

  if (db == null) {
    throw new Error(
      "createHookContext requires a database: pass `db`, `database: { db }`, or `kernel: { database: { db } }`.",
    );
  }

  return {
    actor: args.actor,
    tx: args.tx ?? null,
    logger: args.logger,
    services: args.services,
    context: args.context ?? {},
    requestId: args.requestId ?? randomUUID(),
    origin: args.origin ?? "rest",
    // The kernel installs its engine as `services.jobs` before any module is
    // built, so a context that names no engine still enqueues for real. The
    // null adapter is for a context with no kernel behind it at all.
    jobs: args.jobs ?? (args.services.jobs as JobsAdapter | undefined) ?? nullJobs,
    db,
    ...(args.commerceConfig !== undefined ? { commerceConfig: args.commerceConfig } : {}),
  };
}

/** What a core module service already holds that its hook context is built from. */
export interface ModuleHookDeps {
  services: ServiceContainer;
  database: { db: unknown };
  config: CommerceConfig;
}

/**
 * The hook context a core module hands its hooks. Every module builds it the
 * same way — its name as `context.moduleName` (which webhook event names are
 * derived from), a logger scoped to it, the kernel's services (and through them
 * the jobs engine), the database and the config — so none can leave a field out.
 */
export function createModuleHookContext(
  moduleName: string,
  deps: ModuleHookDeps,
  actor: Actor | null,
  tx: unknown = null,
  options: { logScope?: string; context?: Record<string, unknown> } = {},
): HookContext {
  return createHookContext({
    actor,
    tx,
    logger: createConsoleLogger(options.logScope ?? moduleName),
    services: deps.services,
    context: { moduleName, ...options.context },
    database: { db: deps.database.db as PluginDb },
    commerceConfig: deps.config,
  });
}
