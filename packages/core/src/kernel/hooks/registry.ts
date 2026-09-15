export type HookHandler = (...args: never[]) => unknown;

/**
 * Handlers a PLUGIN asked to run inside the writing transaction.
 *
 * Module-level rather than per-registry because a plugin's declaration and its registration are
 * separated by the manifest merge: `manifest.hooks()` returns `{ key, handler, inTransaction }`
 * records, which are flattened into `config.hooks` as a bare `key -> handler[]` map long before any
 * HookRegistry exists. Marking the function itself is the only channel that survives that.
 *
 * Shipped in 0.35.1 because 0.35.0 made after-commit the default with no way for a plugin to opt
 * out, which silently moved `loom_projection_pending` — a transactional outbox whose whole point is
 * committing with the write it records — to after the commit.
 */
const pluginInTransactionHandlers = new WeakSet<object>();

/** Declare that this handler must run inside the writing transaction. Called by the manifest merge. */
export function markHookInTransaction(handler: unknown): void {
  if (typeof handler === "function") pluginInTransactionHandlers.add(handler as object);
}

/** Whether a plugin asked for this handler to run in-transaction. Read by the kernel at boot. */
export function isHookMarkedInTransaction(handler: unknown): boolean {
  return typeof handler === "function" && pluginInTransactionHandlers.has(handler as object);
}

type HookEntry = {
  prepended: HookHandler[];
  configured: HookHandler[];
  appended: HookHandler[];
};

export class HookRegistry {
  private registry = new Map<string, HookEntry>();
  private inTransactionHandlers = new WeakSet<HookHandler>();
  private logger?: { error: (obj: Record<string, unknown>, msg: string) => void };

  registerConfigHooks(hookName: string, handlers: HookHandler[]): void {
    this.ensureEntry(hookName);
    this.registry.get(hookName)!.configured = [...handlers];
  }

  append(hookName: string, handler: HookHandler): void {
    this.ensureEntry(hookName);
    this.registry.get(hookName)!.appended.push(handler);
  }

  appendInTransaction(hookName: string, handler: HookHandler): void {
    this.inTransactionHandlers.add(handler);
    this.append(hookName, handler);
  }

  prepend(hookName: string, handler: HookHandler): void {
    this.ensureEntry(hookName);
    this.registry.get(hookName)!.prepended.push(handler);
  }

  prependInTransaction(hookName: string, handler: HookHandler): void {
    this.inTransactionHandlers.add(handler);
    this.prepend(hookName, handler);
  }

  runsInTransaction(handler: HookHandler): boolean {
    return this.inTransactionHandlers.has(handler);
  }

  resolve(hookName: string): HookHandler[] {
    const entry = this.registry.get(hookName);
    if (!entry) return [];
    return [...entry.prepended, ...entry.configured, ...entry.appended];
  }

  /**
   * Emit a plugin event to all registered listeners.
   *
   * Unlike the before/after hook pattern (which transforms data through
   * a pipeline), emit is fire-and-forget notification. Errors in handlers
   * are caught and logged but do not propagate to the emitter.
   *
   * Usage:
   *   kernel.hooks.emit("production.afterComplete", { orderId, quantity });
   *
   * Any plugin can listen:
   *   hooks: () => [{ key: "production.afterComplete", handler: async (payload) => { ... } }]
   */
  setLogger(logger: { error: (obj: Record<string, unknown>, msg: string) => void }): void {
    this.logger = logger;
  }

  async emit(key: string, payload: unknown): Promise<void> {
    const handlers = this.resolve(key);
    for (const handler of handlers) {
      try {
        await (handler as (payload: unknown) => unknown)(payload);
      } catch (err) {
        this.logger?.error(
          { err, hookKey: key },
          `Event handler failed for "${key}"`,
        );
      }
    }
  }

  private ensureEntry(hookName: string): void {
    if (!this.registry.has(hookName)) {
      this.registry.set(hookName, {
        prepended: [],
        configured: [],
        appended: [],
      });
    }
  }
}
