import type { AppModule } from "./define.js";

export class ModuleCycleError extends Error {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    const label = cycle.join(" → ");
    super(`Module dependency cycle: ${label}`);
    this.name = "ModuleCycleError";
    this.cycle = cycle;
  }
}

export function topoSortModules(modules: Record<string, AppModule>): string[] {
  const keys = Object.keys(modules);
  const keySet = new Set(keys);

  for (const [id, mod] of Object.entries(modules)) {
    for (const dep of mod.dependencies ?? []) {
      const depKey = dep as string;
      if (!keySet.has(depKey)) {
        throw new Error(`Module "${id}" declares unknown dependency "${depKey}"`);
      }
    }
  }

  const remaining = new Map<string, Set<string>>();
  for (const k of keys) {
    const mod = modules[k]!;
    remaining.set(k, new Set((mod.dependencies ?? []) as string[]));
  }

  const waitingOn = new Map<string, string[]>();
  for (const m of keys) {
    const mod = modules[m]!;
    for (const d of (mod.dependencies ?? []) as string[]) {
      const list = waitingOn.get(d);
      if (list) list.push(m);
      else waitingOn.set(d, [m]);
    }
  }

  const order: string[] = [];
  const queue = keys.filter((k) => remaining.get(k)!.size === 0);

  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of waitingOn.get(n) ?? []) {
      const set = remaining.get(m)!;
      if (set.delete(n) && set.size === 0) {
        queue.push(m);
      }
    }
  }

  if (order.length !== keys.length) {
    const cycle = findCycleKeys(modules, keys);
    throw new ModuleCycleError(cycle);
  }

  return order;
}

function findCycleKeys(modules: Record<string, AppModule>, keys: string[]): string[] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const mark = new Map<string, number>();
  const stack: string[] = [];

  function dfs(u: string): string[] | null {
    mark.set(u, GRAY);
    stack.push(u);
    const mod = modules[u]!;
    for (const v of (mod.dependencies ?? []) as string[]) {
      const mv = mark.get(v) ?? WHITE;
      if (mv === WHITE) {
        const found = dfs(v);
        if (found) return found;
      } else if (mv === GRAY) {
        const idx = stack.indexOf(v);
        return [...stack.slice(idx), v];
      }
    }
    stack.pop();
    mark.set(u, BLACK);
    return null;
  }

  for (const k of keys) {
    if ((mark.get(k) ?? WHITE) === WHITE) {
      const found = dfs(k);
      if (found) return found;
    }
  }

  throw new Error("topoSortModules: expected a cycle but DFS did not find one");
}
