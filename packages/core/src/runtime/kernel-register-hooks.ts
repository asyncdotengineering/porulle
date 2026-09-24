import type { CommerceConfig } from "../config/types.js";
import { HookRegistry, type HookHandler } from "../kernel/hooks/registry.js";
import { deliverWebhooks, deliverWebhooksForAdjustMany } from "../modules/webhooks/hook.js";
import { syncToSearchIndex } from "../modules/search/hooks.js";
import { auditHooks } from "../modules/audit/hooks.js";
import { assertBulkHookPairs } from "../kernel/hooks/bulk-pairs.js";

export function registerConfiguredKernelHooks(
  config: CommerceConfig,
  hooks: HookRegistry,
): void {
  for (const [entityType, entityConfig] of Object.entries(
    config.entities ?? {},
  )) {
    const entityHooks = entityConfig.hooks ?? {};
    for (const [hookName, handlers] of Object.entries(entityHooks)) {
      hooks.registerConfigHooks(
        `catalog.${entityType}.${hookName}`,
        handlers ?? [],
      );
    }
  }

  for (const [moduleName, moduleConfig] of [
    ["cart", config.cart],
    ["checkout", config.checkout],
    ["orders", config.orders],
    ["inventory", config.inventory],
  ] as const) {
    const hooksObject = moduleConfig?.hooks;
    if (!hooksObject) continue;
    assertBulkHookPairs(
      Object.entries(hooksObject).filter(([, handlers]) => Array.isArray(handlers) && handlers.length > 0).map(([hookName]) => `${moduleName}.${hookName}`),
      `config.${moduleName}.hooks`,
    );
    for (const [hookName, handlers] of Object.entries(hooksObject)) {
      const normalizedHandlers = (Array.isArray(handlers) ? handlers : []) as HookHandler[];
      hooks.registerConfigHooks(
        `${moduleName}.${hookName}`,
        normalizedHandlers,
      );
    }
  }

  hooks.append("orders.afterCreate", deliverWebhooks);
  hooks.append("orders.afterStatusChange", deliverWebhooks);
  hooks.append("catalog.afterCreate", deliverWebhooks);
  hooks.append("catalog.afterUpdate", deliverWebhooks);
  hooks.append("catalog.afterDelete", deliverWebhooks);
  hooks.append("inventory.afterAdjust", deliverWebhooks);
  hooks.append("inventory.afterAdjustMany", deliverWebhooksForAdjustMany as HookHandler);
  hooks.append("customers.afterCreate", deliverWebhooks);
  hooks.append("customers.afterUpdate", deliverWebhooks);
  hooks.append("pricing.afterCreate", deliverWebhooks);
  hooks.append("pricing.afterUpdate", deliverWebhooks);
  hooks.append("promotions.afterCreate", deliverWebhooks);
  hooks.append("promotions.afterUpdate", deliverWebhooks);
  hooks.append("fulfillment.afterCreate", deliverWebhooks);
  hooks.append("cart.afterAddItem", deliverWebhooks);

  hooks.append("catalog.afterCreate", syncToSearchIndex);
  hooks.append("catalog.afterUpdate", syncToSearchIndex);

  for (const [key, handler] of Object.entries(auditHooks)) {
    hooks.appendInTransaction(key, handler);
  }
}
