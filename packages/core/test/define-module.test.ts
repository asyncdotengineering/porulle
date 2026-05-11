import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../src/kernel/database/adapter.js";
import { HookRegistry } from "../src/kernel/hooks/registry.js";
import {
  defineModule,
  ModuleCycleError,
  type ModuleDeps,
  type ServiceMap,
  topoSortModules,
} from "../src/kernel/module/index.js";

function minimalDeps<TDeps extends Record<string, unknown> = Record<string, unknown>>(
  services: TDeps,
): ModuleDeps<TDeps> {
  const adapter: DatabaseAdapter = {
    provider: "test",
    db: {},
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn({});
    },
  };
  const logger = {
    info() {},
    warn() {},
    error() {},
  };
  return {
    db: adapter,
    hooks: new HookRegistry(),
    services,
    config: {},
    logger,
  };
}

describe("defineModule", () => {
  it("infers TService from the service factory", () => {
    const mod = defineModule({
      id: "demo",
      schema: () => ({ version: 1 }),
      service: () => ({ branch: "inferred" as const }),
    });
    type Inferred = ReturnType<(typeof mod)["service"]>;
    const acceptsInferred = (x: Inferred) => x.branch;
    expect(acceptsInferred(mod.service(minimalDeps({})))).toBe("inferred");
  });

  it("types deps.services from ModuleDeps<TDeps>", () => {
    type PricingService = { quote(n: number): number };
    const run = (deps: ModuleDeps<{ pricing: PricingService }>) => deps.services.pricing.quote(3);

    const deps = minimalDeps({
      pricing: { quote: (n: number) => n + 1 },
    });
    expect(run(deps)).toBe(4);
  });

  it("ServiceMap maps module record keys to service types", () => {
    const modA = defineModule({
      id: "a",
      schema: () => ({}),
      service: () => ({ kind: "a" as const }),
    });
    const modB = defineModule({
      id: "b",
      schema: () => ({}),
      service: () => ({ kind: "b" as const }),
    });
    type M = ServiceMap<{ alpha: typeof modA; beta: typeof modB }>;
    const takeAlpha = (x: M["alpha"]) => x.kind;
    const takeBeta = (x: M["beta"]) => x.kind;
    expect(takeAlpha({ kind: "a" })).toBe("a");
    expect(takeBeta({ kind: "b" })).toBe("b");
  });
});

describe("topoSortModules", () => {
  it("orders modules respecting dependencies", () => {
    const pricing = defineModule({
      id: "pricing",
      schema: () => ({}),
      service: () => ({}),
    });
    const catalog = defineModule({
      id: "catalog",
      schema: () => ({}),
      dependencies: ["pricing"],
      service: () => ({}),
    });
    const cart = defineModule({
      id: "cart",
      schema: () => ({}),
      dependencies: ["catalog"],
      service: () => ({}),
    });

    const order = topoSortModules({ pricing, catalog, cart });
    expect(order.indexOf("pricing")).toBeLessThan(order.indexOf("catalog"));
    expect(order.indexOf("catalog")).toBeLessThan(order.indexOf("cart"));
    expect(order).toEqual(["pricing", "catalog", "cart"]);
  });

  it("throws ModuleCycleError with named cycle when a cycle exists", () => {
    const a = defineModule({
      id: "a",
      schema: () => ({}),
      dependencies: ["b"],
      service: () => ({}),
    });
    const b = defineModule({
      id: "b",
      schema: () => ({}),
      dependencies: ["a"],
      service: () => ({}),
    });

    expect(() => topoSortModules({ a, b })).toThrow(ModuleCycleError);
    try {
      topoSortModules({ a, b });
    } catch (e) {
      expect(e).toBeInstanceOf(ModuleCycleError);
      expect((e as ModuleCycleError).cycle.length).toBeGreaterThanOrEqual(2);
      expect((e as ModuleCycleError).message).toContain("→");
    }
  });
});

void defineModule<unknown, unknown, { pricing: { x: number } }>({
  id: "bad-dep-key",
  schema: () => ({}),
  // @ts-expect-error — "pricng" is not a key of { pricing: ... }
  dependencies: ["pricng"],
  service: () => ({}),
});
