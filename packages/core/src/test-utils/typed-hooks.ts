import type { PluginHookRegistration } from "../kernel/plugin/manifest.js";
import type { HookContext, HookOperation } from "../kernel/hooks/types.js";

/**
 * Creates a typed before-hook registration for plugins.
 *
 * Narrows the handler signature from the loose `(...args: unknown[]) => unknown`
 * on PluginHookRegistration to the actual `{ data, operation, context }` shape,
 * providing autocomplete on context.jobs.enqueue(), context.logger.info(), etc.
 *
 * @example
 * ```typescript
 * hooks: () => [
 *   beforeHook<{ customerId: string }>("orders.beforeCreate", async ({ data, context }) => {
 *     context.logger.info("order_creating", { customerId: data.customerId });
 *     return data;
 *   }),
 * ],
 * ```
 */
export function beforeHook<TData>(
  key: string,
  handler: (args: {
    data: TData;
    operation: HookOperation;
    context: HookContext;
  }) => Promise<TData> | TData,
): PluginHookRegistration {
  return { key, handler: handler as PluginHookRegistration["handler"] };
}

/**
 * Creates a typed after-hook registration for plugins.
 *
 * @example
 * ```typescript
 * import { resolveOrgId } from "@porulle/core";
 * hooks: () => [
 *   afterHook<{ id: string; grandTotal: number }>("orders.afterCreate", async ({ result, context }) => {
 *     await context.jobs.enqueue("loyalty:award-points", { orderId: result.id }, { organizationId: resolveOrgId(context.actor) });
 *   }),
 * ],
 * ```
 */
export function afterHook<TData>(
  key: string,
  handler: (args: {
    data: TData | null;
    result: TData;
    operation: HookOperation;
    context: HookContext;
  }) => Promise<void> | void,
): PluginHookRegistration {
  return { key, handler: handler as PluginHookRegistration["handler"] };
}
