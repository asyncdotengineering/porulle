import type { DatabaseAdapter } from "../database/adapter.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { Logger } from "../hooks/types.js";

export interface ModuleDeps<TDeps extends Record<string, unknown> = Record<string, unknown>> {
  db: DatabaseAdapter;
  hooks: HookRegistry;
  services: TDeps;
  config: unknown;
  logger: Logger;
}

export interface AppModule<
  TSchema = unknown,
  TService = unknown,
  TDeps extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  schema: () => TSchema;
  dependencies?: ReadonlyArray<keyof TDeps & string>;
  service: (deps: ModuleDeps<TDeps>) => TService;
}

export type ServiceMap<TModules extends Record<string, AppModule>> = {
  [K in keyof TModules]: TModules[K] extends AppModule<infer _TSchema, infer TService, infer _TDeps>
    ? TService
    : never;
};

export function defineModule<
  TSchema,
  TService,
  TDeps extends Record<string, unknown> = Record<string, unknown>,
>(manifest: AppModule<TSchema, TService, TDeps>): AppModule<TSchema, TService, TDeps> {
  return manifest;
}
