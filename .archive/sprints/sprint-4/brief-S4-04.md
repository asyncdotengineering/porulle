# Story Brief — `S4-04` Tier-2 modules → `defineModule` (catalog, inventory)

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`. **Depends on S4-03.**
>
> **Atomic-commit policy:** ONE commit `[S4-04] tier-2 modules use defineModule`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s4-04-tier2.done`.

---

## 1. Goal

Convert catalog and inventory to `defineModule`. These have moderate cross-service dependencies — catalog uses pricing for some lookups; inventory uses catalog for entity validation.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. The S4-03 commit.
2. `packages/core/src/modules/catalog/service.ts` — read constructor + cross-service calls (`grep "this.deps.services\."`).
3. `packages/core/src/modules/inventory/service.ts` — same.
4. `runtime/kernel.ts` — current wiring of both.

---

## 3. Approach

```typescript
// catalog/module.ts
export const catalogModule = defineModule({
  id: "catalog",
  dependencies: ["pricing"],  // if catalog reads pricing; verify by grep
  schema: () => ({ sellableEntities, variants, categories, brands, attributes }),
  service: (deps) => new CatalogServiceImpl({
    repository: new CatalogRepository(deps.db),
    hooks: deps.hooks,
    config: deps.config,
    services: deps.services,  // typed: { pricing: PricingService }
  }),
});

// inventory/module.ts
export const inventoryModule = defineModule({
  id: "inventory",
  dependencies: ["catalog"],
  schema: () => ({ inventoryLevels, inventoryMovements, warehouses }),
  service: (deps) => new InventoryService({
    repository: new InventoryRepository(deps.db),
    hooks: deps.hooks,
    config: deps.config,
    services: deps.services,  // typed: { catalog: CatalogServiceImpl }
    database: deps.db,  // some repos still need this
  }),
});
```

Note: existing `*ServiceDeps` interfaces still type `services: Record<string, unknown>`. **Do not change that yet** — the type-narrowing happens at the `defineModule.service` factory's `deps.services` (which is properly typed because `dependencies` declares the keys). Inside the service constructor, the repo / service still uses the old loose types.

Sprint 4 finish line is "narrow at the boundary, broaden internally." Full `Record<string, unknown>` removal is out of scope (would break too much per-story).

---

## 4. Files to modify

**Create:**
- `packages/core/src/modules/catalog/module.ts`
- `packages/core/src/modules/inventory/module.ts`

**Tests:**
- `packages/core/test/module-tier2.test.ts` — type tests.

**Do not touch:**
- Service class methods or signatures (just constructors are fine; wiring stays in kernel until S4-06).
- `runtime/kernel.ts`.

---

## 5. Acceptance criteria

1. `catalogModule` + `inventoryModule` exist.
2. Their `dependencies` arrays match what services they actually read.
3. Type tests prove `deps.services.<deps>` is properly typed.
4. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S4-04] tier-2 modules use defineModule`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT remove `Record<string, unknown>` from service constructor `deps.services` — that's beyond Sprint 4's scope.
- Do NOT modify service method signatures.
