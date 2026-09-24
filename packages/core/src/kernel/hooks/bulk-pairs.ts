/**
 * Hooks with a bulk sibling. An operation that writes a whole page at once announces ONLY the bulk
 * hook — `inventory.setAbsoluteMany` fires `inventory.afterAdjustMany` once per page, not
 * `inventory.afterAdjust` per level — so a subscriber to the single hook alone would go silently
 * blind to every bulk write. Registering the single without the bulk is refused at boot, loudly,
 * naming who did it: a boot failure is found by the first test or dev run, a missing event never is.
 */
export const BULK_HOOK_PAIRS: Readonly<Record<string, string>> = {
  "inventory.afterAdjust": "inventory.afterAdjustMany",
};

export function assertBulkHookPairs(keys: Iterable<string>, registeredBy: string): void {
  const registered = new Set(keys);
  for (const [single, bulk] of Object.entries(BULK_HOOK_PAIRS)) {
    if (registered.has(single) && !registered.has(bulk)) {
      throw new Error(
        `${registeredBy} subscribes to "${single}" but not to "${bulk}". Bulk writes (e.g. a store's `
        + `inventory sync through setAbsoluteMany) announce only "${bulk}", once per page grouped by `
        + `product — subscribe to it too, or this subscriber never sees them.`,
      );
    }
  }
}
