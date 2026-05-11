/**
 * ServiceRegistry -- typed surface of the kernel service container
 * for plugin-to-plugin communication.
 *
 * Plugin services accept this as an optional constructor parameter
 * to call core services without resorting to raw SQL.
 *
 * Core services are loosely typed here (method signatures use `unknown`)
 * to avoid plugin packages depending on core's internal service types.
 * Plugin authors cast the return values at the call site.
 *
 * Usage in a plugin service:
 *
 *   import type { ServiceRegistry } from "@porulle/core";
 *
 *   class MyService {
 *     constructor(private db: PluginDb, private services?: ServiceRegistry) {}
 *
 *     async doWork() {
 *       const result = await this.services?.inventory.adjust({
 *         entityId: "...", adjustment: -5, reason: "recipe deduction"
 *       }, actor);
 *     }
 *   }
 */

export interface ServiceRegistry {
  inventory: {
    adjust(
      input: {
        entityId: string;
        variantId?: string;
        warehouseId?: string;
        adjustment: number;
        reason?: string;
      },
      actor?: unknown,
    ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    createWarehouse(
      input: { name: string; code: string },
      actor?: unknown,
    ): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    reserve(input: unknown, actor?: unknown): Promise<unknown>;
    release(input: unknown, actor?: unknown): Promise<unknown>;
    getAvailable(input: unknown, actor?: unknown): Promise<unknown>;
    [method: string]: unknown;
  };
  catalog: {
    create(input: unknown, actor?: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    getById(id: string, options?: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    publish(id: string, actor?: unknown): Promise<unknown>;
    list(input?: unknown): Promise<unknown>;
    [method: string]: unknown;
  };
  customers: {
    getByUserId(userId: string, actor?: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    getById(id: string, actor?: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    [method: string]: unknown;
  };
  orders: {
    create(input: unknown, actor?: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    changeStatus(input: unknown, actor?: unknown): Promise<unknown>;
    [method: string]: unknown;
  };
  cart: {
    create(input: unknown, actor?: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    [method: string]: unknown;
  };
  organization: {
    create(input: unknown): Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
    getById(id: string): Promise<unknown>;
    [method: string]: unknown;
  };
  /** Access plugin-registered services by plugin ID or service name */
  [key: string]: unknown;
}
