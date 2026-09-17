import type { Actor } from "../../auth/types.js";
import type { CommerceConfig } from "../../config/types.js";
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
  | "recover"
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
  commerceConfig?: CommerceConfig | null;
}

export type BeforeHook<TData> = (args: {
  data: TData;
  operation: HookOperation;
  context: HookContext;
}) => Promise<TData> | TData;

/**
 * `data` is what went in, `result` is what was committed. For most operations
 * those are the same shape, so `TData` defaults to `TResult` and a single type
 * argument keeps its old meaning.
 *
 * They differ where the committed entity is not the input: a status change
 * commits a hydrated order but its input is the transition itself, and a hook
 * that cannot see which transition occurred cannot act on one.
 */
export type AfterHook<TResult, TData = TResult> = (args: {
  data: TData | null;
  result: TResult;
  operation: HookOperation;
  context: HookContext;
}) => Promise<void> | void;
