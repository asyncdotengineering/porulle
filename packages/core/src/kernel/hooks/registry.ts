export type HookHandler = (...args: never[]) => unknown;

type HookEntry = {
  prepended: HookHandler[];
  configured: HookHandler[];
  appended: HookHandler[];
};

export class HookRegistry {
  private registry = new Map<string, HookEntry>();
  private logger?: { error: (obj: Record<string, unknown>, msg: string) => void };

  registerConfigHooks(hookName: string, handlers: HookHandler[]): void {
    this.ensureEntry(hookName);
    this.registry.get(hookName)!.configured = [...handlers];
  }

  append(hookName: string, handler: HookHandler): void {
    this.ensureEntry(hookName);
    this.registry.get(hookName)!.appended.push(handler);
  }

  prepend(hookName: string, handler: HookHandler): void {
    this.ensureEntry(hookName);
    this.registry.get(hookName)!.prepended.push(handler);
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
