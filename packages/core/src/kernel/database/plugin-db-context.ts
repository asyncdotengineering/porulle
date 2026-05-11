import { AsyncLocalStorage } from "node:async_hooks";

const pluginDbOrgStorage = new AsyncLocalStorage<{ organizationId: string }>();

export function runWithPluginDatabaseScope<T>(
  organizationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return pluginDbOrgStorage.run({ organizationId }, fn);
}

export function getPluginDatabaseScopeOrganizationId(): string | undefined {
  return pluginDbOrgStorage.getStore()?.organizationId;
}
