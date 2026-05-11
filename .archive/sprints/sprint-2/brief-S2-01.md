# Story Brief — `S2-01` Webhook `moduleName` fix across 6 services

> **You are the IC engineer (`cursor` worker, fresh process; clean context).** Branch: `foundation-repair`.
>
> **Atomic-commit policy:** ONE commit `[S2-01] webhooks fire correct event names for all modules`. **Sentinel:** `echo "DONE $(git rev-parse HEAD)" > .handoff/result-s2-01-webhook-modulename.done`.

---

## 1. Goal

Fix the live bug LB-1 where webhook delivery for catalog, cart, customers, pricing, promotions, and fulfillment fires as `unknown.create`/`unknown.update` because only `OrderService` and `InventoryService` set `context.context.moduleName`. Subscribers filtering on event name silently miss every event from these 6 modules.

---

## 1.5 Validation policy (sprint-wide)

Do NOT run `bun run test`, `bun run check-types`, or `bun run lint`. Manager runs at gate.

---

## 2. Required reading

1. `FRAMEWORK-WIKI-PHASE-2.md` §2 LB-1.
2. `packages/core/src/modules/webhooks/hook.ts` — line 14 derives event name from `context.context.moduleName ?? "unknown"`.
3. `packages/core/src/modules/orders/service.ts` line ~108 — **the model pattern**: `context: { moduleName: "orders" }` passed to `createHookContext`.
4. `packages/core/src/modules/inventory/service.ts` line ~364 — same pattern.
5. The 6 services missing the `moduleName`:
   - `packages/core/src/modules/catalog/service.ts`
   - `packages/core/src/modules/cart/service.ts`
   - `packages/core/src/modules/customers/service.ts`
   - `packages/core/src/modules/pricing/service.ts`
   - `packages/core/src/modules/promotions/service.ts`
   - `packages/core/src/modules/fulfillment/service.ts`

---

## 3. Files to modify

For each of the 6 services above: find every `createHookContext({ ... })` invocation (typically before `runBeforeHooks` or `runAfterHooks`). Add `context: { moduleName: "<modulename>" }` to the args.

The 6 module names (use these exact strings):
- `catalog`
- `cart`
- `customers`
- `pricing`
- `promotions`
- `fulfillment`

**Create:**
- `packages/core/test/webhooks-event-names.test.ts` — for each of the 6 modules, register a webhook subscriber, perform a create operation, assert the delivered event name matches `<module>.afterCreate` (NOT `unknown.create`). 6 test cases.

**Do not touch:**
- `orders` and `inventory` services — they're already correct.
- The webhook delivery worker / hook itself.
- The schema or repository.

---

## 4. Acceptance criteria

1. All 6 services pass `context: { moduleName: "<name>" }` in every `createHookContext()` call. Audit by `git diff` per file.
2. Test `webhooks-event-names.test.ts` exists with 6 cases asserting non-`unknown` event names.
3. No `as any`, no `@ts-ignore`. No public-surface drift.
4. Atomic commit + sentinel.

---

## 5. DoD

- [ ] All AC met.
- [ ] Atomic commit `[S2-01] webhooks fire correct event names for all modules`.
- [ ] Sentinel `.handoff/result-s2-01-webhook-modulename.done`.

---

## 6. What NOT to do

- Do NOT modify the webhook hook or worker.
- Do NOT add a "default moduleName" mechanism to `createHookContext` — it's safer to be explicit per-service (forces every new service to pick a name).
- Do NOT touch other modules (audit, search, media, etc.) — they have their own hook context construction; out of scope.
