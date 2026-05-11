# Story Brief — `S4-06` Rewrite `createKernel` with topo-sort

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`. **Depends on S4-02 through S4-05.**
>
> **Atomic-commit policy:** ONE commit `[S4-06] createKernel uses module topo-sort`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s4-06-kernel-rewrite.done`.

---

## 1. Goal

Replace the manual 200-line wiring at `runtime/kernel.ts:218-346` with module-driven instantiation via `topoSortModules` + iterating module factories. This is the payoff for S4-01 through S4-05.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. S4-01 through S4-05 commits — read all module.ts files.
2. `packages/core/src/runtime/kernel.ts` — full file. Lines 218–346 are the manual wiring to replace.
3. `packages/core/src/kernel/module/topo-sort.ts` (from S4-01).

---

## 3. Approach

New `createKernel` flow:

```typescript
const ALL_MODULES = {
  audit: auditModule,
  webhooks: webhooksModule,
  media: mediaModule,
  organization: organizationModule,
  customers: customersModule,
  pricing: pricingModule,
  catalog: catalogModule,
  inventory: inventoryModule,
  cart: cartModule,
  orders: ordersModule,
  fulfillment: fulfillmentModule,
  promotions: promotionsModule,
  search: searchModule,
  shipping: shippingModule,
  tax: taxModule,
  payments: paymentsModule,
  analytics: analyticsModule,
} as const;

export function createKernel(config: CommerceConfig): Kernel {
  // ... existing setup (database, hooks, logger, mcpTools) ...

  const order = topoSortModules(ALL_MODULES);  // ['audit', 'webhooks', 'organization', 'pricing', 'catalog', ...]
  const services: Partial<ServiceMap<typeof ALL_MODULES>> = {};
  
  for (const id of order) {
    const module = ALL_MODULES[id];
    services[id] = module.service({
      db: database.db,
      hooks,
      services: services as ServiceMap<typeof ALL_MODULES>,  // earlier modules are populated; later ones not yet — type narrows by dep declaration
      config,
      logger,
    });
  }

  // existing post-instantiation steps: timing proxy, hook registration, etc.
  
  // Service-container exposure for plugins (UNCHANGED — still uses Record<string, unknown> for plugin compat)
  const serviceContainer = services as Record<string, unknown>;
  serviceContainer.database = database;
  serviceContainer.jobs = jobsAdapter;

  return { config, hooks, database, services, ... };
}
```

Note: the `serviceContainer as Record<string, unknown>` exposure for plugins STAYS — plugins still receive an untyped bag. The improvement is that core service-to-service calls are now typed via the module system. A future story (post-Sprint-4) could narrow plugins too.

---

## 4. Files to modify

**Modify:**
- `packages/core/src/runtime/kernel.ts` — replace lines 218–346 with the topo-sort + module-loop. Preserve all post-instantiation behavior (timing proxy, hooks registration, MCP, etc.).

**Tests:**
- `packages/core/test/kernel-module-wiring.test.ts` — boot a kernel with the module list; assert all 17 services are instantiated; assert dependency order satisfied (e.g., catalog instantiated before inventory).

**Do not touch:**
- Module definition files (S4-02 through S4-05).
- Service classes.
- Kernel public API (`Kernel` interface).

---

## 5. Acceptance criteria

1. `runtime/kernel.ts` is < 250 lines (was 427+).
2. The manual `services.tax = ...; services.payments = ...; ...` wiring is gone, replaced by the module loop.
3. `topoSortModules(ALL_MODULES)` produces a valid order; runtime asserts it.
4. All existing tests pass (verify by inspection — manager runs at gate).
5. No `as any`, no `@ts-ignore`. The `services as Record<string, unknown>` cast for plugin compat is acceptable (documented).
6. Plugin service container behavior unchanged.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S4-06] createKernel uses module topo-sort`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT change the `Kernel` public type (consumers still access `kernel.services.<x>`).
- Do NOT remove the timing proxy or audit/webhook hook registration — preserve existing post-init behavior.
- Do NOT migrate plugins off `ctx.services` — that's a future sprint.
- Do NOT skip the topo-sort cycle check — it's the safety net for S4-05's dep declarations.
