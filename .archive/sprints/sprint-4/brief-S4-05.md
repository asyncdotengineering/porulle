# Story Brief — `S4-05` Tier-3 modules → `defineModule`

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`. **Depends on S4-04.**
>
> **Atomic-commit policy:** ONE commit `[S4-05] tier-3 modules use defineModule`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s4-05-tier3.done`.

---

## 1. Goal

Convert the remaining 9 modules to `defineModule`: cart, orders, fulfillment, promotions, search, shipping, tax, payments, analytics. These are tier-3 because they depend on multiple other services — declare the dependencies explicitly.

---

## 1.5 Validation policy

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. S4-02, S4-03, S4-04 commits — for the pattern.
2. Each of the 9 modules' `service.ts`:
   - `cart/service.ts` — depends on catalog, inventory.
   - `orders/service.ts` — depends on cart, inventory, payments, pricing, promotions, fulfillment.
   - `fulfillment/service.ts` — depends on orders, inventory.
   - `promotions/service.ts` — depends on catalog, orders.
   - `search/service.ts` — depends on catalog.
   - `shipping/service.ts` — depends on catalog.
   - `tax/service.ts` — minimal deps.
   - `payments/service.ts` — minimal deps (config-driven adapter).
   - `analytics/service.ts` — depends on Drizzle adapter; minimal service deps.
3. `runtime/kernel.ts` — for current wiring of each.

For each module, run `grep "this.deps.services\." packages/core/src/modules/<name>/service.ts | sort -u | sed 's/.*services\.//' | cut -d. -f1` to enumerate actual service dep usage.

---

## 3. Approach

Mirror S4-02 through S4-04. For each module:

```typescript
export const cartModule = defineModule({
  id: "cart",
  dependencies: ["catalog", "inventory"],
  schema: () => ({ cart, cartItems }),
  service: (deps) => new CartService({...}),
});
```

For complex modules (orders), the dependency list will be longer:

```typescript
dependencies: ["cart", "inventory", "payments", "pricing", "promotions", "fulfillment"]
```

If a module has cycles with another (e.g., orders ↔ fulfillment because fulfillment uses ordersRepository), declare only the **forward** dep (orders → fulfillment) and let fulfillment use lazy late-binding (`deps.services.orders` resolved at first call, not constructor time). This is the cleanest way to avoid topo-sort failures.

If a true cycle exists (mutual constructor needs), STUCK and write a `.handoff/blocked-s4-05-tier3.md` documenting the cycle.

---

## 4. Files to modify

**Create (9 module.ts files):**
- `packages/core/src/modules/cart/module.ts`
- `packages/core/src/modules/orders/module.ts`
- `packages/core/src/modules/fulfillment/module.ts`
- `packages/core/src/modules/promotions/module.ts`
- `packages/core/src/modules/search/module.ts`
- `packages/core/src/modules/shipping/module.ts`
- `packages/core/src/modules/tax/module.ts`
- `packages/core/src/modules/payments/module.ts`
- `packages/core/src/modules/analytics/module.ts`

**Tests:**
- `packages/core/test/module-tier3.test.ts` — type tests for each.

**Do not touch:**
- Service class methods/logic.
- `runtime/kernel.ts` — S4-06.
- Repositories.

---

## 5. Acceptance criteria

1. All 9 module.ts files exist.
2. Each declares accurate `dependencies` (verifiable via grep).
3. Type tests confirm typed `deps.services.<dep>` access.
4. No cycles in the dependency graph (S4-06's topo-sort would fail otherwise; verify by mental simulation).
5. No `as any`, no `@ts-ignore`.

---

## 6. DoD

- [ ] All 9 modules converted.
- [ ] Atomic commit `[S4-05] tier-3 modules use defineModule`.
- [ ] Sentinel.

---

## 7. What NOT to do

- Do NOT remove inline `as { ... }` casts inside service method bodies (those go away in a future post-Sprint-4 refactor).
- Do NOT modify kernel.ts (S4-06).
- Do NOT introduce decorator metadata.
