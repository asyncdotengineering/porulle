import { randomUUID } from "node:crypto";
import type { Actor } from "../../auth/types.js";
import type { JobsAdapter } from "../jobs/adapter.js";
import { NullJobsAdapter } from "../jobs/adapter.js";
import type { PluginDb } from "../database/plugin-types.js";
import type { HookContext, HookOrigin, Logger, ServiceContainer } from "./types.js";

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
    jobs: args.jobs ?? nullJobs,
    db,
  };
}
