import type { Actor } from "../../auth/types.js";
import type { JobsAdapter } from "../jobs/adapter.js";
import type { PluginDb } from "../database/plugin-types.js";

export type HookOperation =
  | "create"
  | "update"
  | "delete"
  | "read"
  | "list"
  | "statusChange"
  | "addItem"
  | "removeItem"
  | "custom";

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface ServiceContainer {
  [key: string]: unknown;
}

export type HookOrigin = "rest" | "local";

export interface HookContext {
  actor: Actor | null;
  tx: unknown;
  logger: Logger;
  services: ServiceContainer;
  context: Record<string, unknown>;
  requestId: string;
  origin: HookOrigin;
  jobs: JobsAdapter;
  /**
   * Drizzle database instance for hook handlers.
   * Populated by `createHookContext` when callers pass `db`, `database`, or `kernel`.
   */
  db: PluginDb;
}

export type BeforeHook<TData> = (args: {
  data: TData;
  operation: HookOperation;
  context: HookContext;
}) => Promise<TData> | TData;

export type AfterHook<TData> = (args: {
  data: TData | null;
  result: TData;
  operation: HookOperation;
  context: HookContext;
}) => Promise<void> | void;
