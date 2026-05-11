# Story Brief — `S4-03` Tier-1 modules → `defineModule` (customers, pricing)

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`. **Depends on S4-02.**
>
> **Atomic-commit policy:** ONE commit `[S4-03] tier-1 modules use defineModule`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s4-03-tier1.done`.

---

## 1. Goal

Convert customers and pricing to `defineModule`. These are tier-1 because they have minimal cross-service dependencies (mostly leaf-like, but pricing references catalog).

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. The S4-02 commit — for the pattern.
2. `packages/core/src/modules/customers/service.ts` + `repository/index.ts`.
3. `packages/core/src/modules/pricing/service.ts` + `repository/index.ts`.
4. `runtime/kernel.ts` — current instantiation. Note: customer service wraps `customersRepository`; pricing wraps `pricingRepository` AND references `catalogRepository`. Pricing has a soft dep on catalog.

---

## 3. Approach

```typescript
// packages/core/src/modules/customers/module.ts
export const customersModule = defineModule({
  id: "customers",
  schema: () => ({ customers, customerAddresses }),
  service: (deps) => new CustomerService({
    repository: new CustomersRepository(deps.db),
  }),
});

// packages/core/src/modules/pricing/module.ts
export const pricingModule = defineModule({
  id: "pricing",
  dependencies: ["catalog"],  // declared dep — typed via TDeps
  schema: () => ({ priceList, priceListItem }),
  service: (deps) => new PricingService({
    repository: new PricingRepository(deps.db),
    catalogRepository: deps.services.catalog.repository,  // typed access
  }),
});
```

Wait — `pricing` accesses `catalogRepository`, not the catalog SERVICE. The current pattern passes `catalogRepository` as a constructor field. Either:
- Keep `catalogRepository` instantiated separately and pass it (parallel to current behavior).
- OR have the catalog module expose its repository.

Simplest: **expose `catalog.repository` as a property on `CatalogServiceImpl`** — add a getter if not present. Then `pricing` can declare `dependencies: ["catalog"]` and access `deps.services.catalog.repository`.

Document the choice in the commit body.

---

## 4. Files to modify

**Create:**
- `packages/core/src/modules/customers/module.ts`
- `packages/core/src/modules/pricing/module.ts`

**Possibly modify:**
- `packages/core/src/modules/catalog/service.ts` — expose `repository` as a public property (if not already) so pricing can read it. Document why.

**Tests:**
- `packages/core/test/module-tier1.test.ts` — type tests + `pricingModule.service({...mockDeps with catalog})` works.

**Do not touch:**
- `runtime/kernel.ts` — S4-06.
- The service classes' methods/logic.

---

## 5. Acceptance criteria

1. `customersModule` + `pricingModule` exist.
2. `pricingModule.dependencies === ["catalog"]` (or whatever the existing dep is).
3. Type tests prove `deps.services.catalog` is properly typed inside pricing's factory.
4. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S4-03] tier-1 modules use defineModule`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT modify the kernel.ts wiring (S4-06).
- Do NOT introduce circular deps. If pricing needs catalog and catalog needs pricing — STUCK and surface to manager.
